// Zapisovač – nahrávání schůzek, průběžný přepis a zápis ze schůzky.
// Vše běží v telefonu; data se ukládají do IndexedDB, klíče do localStorage.

const SDK_URL = "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.137.0/+esm";
const NOTES_MODEL = "claude-opus-5-5";
const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_MODEL = "whisper-large-v3";
const ELEVEN_URL = "https://api.elevenlabs.io/v1/speech-to-text";
const ELEVEN_MODEL = "scribe_v2";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const SEGMENT_SECONDS = 20;          // délka úseku pro průběžný přepis
const MAX_UPLOAD = 24 * 1024 * 1024; // Groq zdarma bere soubory do 25 MB
const CHUNK_SECONDS = 600;           // delší soubory se dělí na 10min části

const $ = (s) => document.querySelector(s);

// ---------- nastavení ----------

const SETTINGS_KEY = "zapisovac.settings";
const DEFAULTS = {
  sttProvider: "groq",
  groqKey: "",
  elevenKey: "",
  notesProvider: "gemini",
  geminiKey: "",
  geminiModel: "gemini-3.6-flash",
  anthropicKey: "",
  email: "zsiska@seznam.cz",
};

function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings(s) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    toast("Nastavení se nepodařilo uložit.");
  }
}

function sttKey(st = loadSettings()) {
  return st.sttProvider === "elevenlabs" ? st.elevenKey : st.groqKey;
}

function missingKeys(st = loadSettings()) {
  return !sttKey(st)
    || (st.notesProvider === "gemini" && !st.geminiKey)
    || (st.notesProvider === "anthropic" && !st.anthropicKey);
}

// ---------- úložiště ----------

let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("zapisovac", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("recordings", { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function store(mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction("recordings", mode);
    const req = fn(t.objectStore("recordings"));
    t.oncomplete = () => resolve(req.result);
    t.onerror = () => reject(t.error);
  });
}

const putRec = (rec) => store("readwrite", (s) => s.put(rec));
const getRec = (id) => store("readonly", (s) => s.get(id));
const allRecs = () => store("readonly", (s) => s.getAll());
const deleteRec = (id) => store("readwrite", (s) => s.delete(id));

// ---------- pomocné ----------

function pad(n) {
  return String(n).padStart(2, "0");
}

function stamp(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}`;
}

function clock(sec) {
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return (h ? `${h}:${pad(m)}` : pad(m)) + `:${pad(sec % 60)}`;
}

function extFor(type) {
  if (/wav/.test(type)) return "wav";
  if (/webm/.test(type)) return "webm";
  if (/mpeg|mp3/.test(type)) return "mp3";
  return "m4a";
}

function fileNameFor(rec) {
  return rec.name.replace(/[\\/:*?"<>|]/g, "-") + "." + extFor(rec.mime || "");
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}

// ---------- poloha ----------

function getPosition() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve(p.coords),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
    );
  });
}

async function placeName(c) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&accept-language=cs&lat=${c.latitude}&lon=${c.longitude}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(res.status);
    const a = (await res.json()).address || {};
    const street = [a.road || a.pedestrian || a.square || a.neighbourhood, a.house_number].filter(Boolean).join(" ");
    const town = a.city || a.town || a.village || a.municipality || "";
    return [street, town].filter(Boolean).join(", ");
  } catch {
    return `${c.latitude.toFixed(5)}, ${c.longitude.toFixed(5)}`;
  }
}

// ---------- přepis ----------

async function postForm(url, headers, fd, service) {
  let res;
  try {
    res = await fetch(url, { method: "POST", headers, body: fd });
  } catch {
    throw new Error("Přepis selhal: nejste připojeni k internetu.");
  }
  if (res.status === 401) throw new Error(`Přepis selhal: neplatný ${service} klíč.`);
  if (res.status === 429) throw new Error(`Přepis selhal: vyčerpaný limit ${service}, zkuste to později.`);
  if (!res.ok) throw new Error(`Přepis selhal (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// Whisper si v tichu občas „vymyslí“ titulky – takové úseky zahodíme.
const HALLUCINATION = /titulky|subtitles|www\.|děkuji za pozornost|ďakujem za pozornosť/i;

// Jazyk se nezadává, aby šla čeština i slovenština; nápověda ho jen naznačí.
async function transcribeGroq(blob, st) {
  if (!st.groqKey) throw new Error("Chybí Groq API klíč – doplňte ho v Nastavení.");
  const fd = new FormData();
  fd.append("file", blob, "audio." + extFor(blob.type));
  fd.append("model", GROQ_MODEL);
  fd.append("response_format", "verbose_json");
  fd.append("temperature", "0");
  fd.append("prompt", "Pracovní schůzka v češtině, případně ve slovenčine.");
  const data = await postForm(GROQ_URL, { Authorization: `Bearer ${st.groqKey}` }, fd, "Groq");
  if (!data.segments) return (data.text || "").trim();
  return data.segments
    .filter((s) => (s.no_speech_prob ?? 0) < 0.6 && !HALLUCINATION.test(s.text))
    .map((s) => s.text.trim())
    .join(" ")
    .trim();
}

// diarize: rozliší mluvčí; používá se pro finální přepis celé nahrávky.
async function transcribeEleven(blob, st, diarize) {
  if (!st.elevenKey) throw new Error("Chybí ElevenLabs API klíč – doplňte ho v Nastavení.");
  const fd = new FormData();
  fd.append("file", blob, "audio." + extFor(blob.type));
  fd.append("model_id", ELEVEN_MODEL);
  fd.append("tag_audio_events", "false");
  if (diarize) fd.append("diarize", "true");
  const data = await postForm(ELEVEN_URL, { "xi-api-key": st.elevenKey }, fd, "ElevenLabs");
  return diarize ? withSpeakers(data) : (data.text || "").trim();
}

function transcribe(blob, { diarize = false } = {}) {
  const st = loadSettings();
  return st.sttProvider === "elevenlabs" ? transcribeEleven(blob, st, diarize) : transcribeGroq(blob, st);
}

// Poskládá slova do odstavců „Mluvčí N: …“ podle speaker_id.
function withSpeakers(data) {
  const words = (data.words || []).filter((w) => w.type !== "audio_event");
  if (!words.some((w) => w.speaker_id)) return (data.text || "").trim();
  const label = (id) => `Mluvčí ${Number(String(id).replace(/\D/g, "") || 0) + 1}`;
  const lines = [];
  let speaker = null;
  let buf = "";
  for (const w of words) {
    if (w.type === "word" && w.speaker_id && w.speaker_id !== speaker) {
      if (buf.trim()) lines.push(`${label(speaker)}: ${buf.trim()}`);
      speaker = w.speaker_id;
      buf = "";
    }
    buf += w.text;
  }
  if (buf.trim()) lines.push(`${label(speaker)}: ${buf.trim()}`);
  return lines.join("\n\n");
}

// Celá nahrávka: ElevenLabs vezme cokoli najednou, pro Groq se velký soubor
// rozdělí na části ve WAV (16 kHz mono).
async function transcribeFile(blob, onProgress) {
  if (loadSettings().sttProvider === "elevenlabs") {
    onProgress("Přepisuji celou nahrávku a rozlišuji mluvčí…");
    return transcribe(blob, { diarize: true });
  }
  if (blob.size <= MAX_UPLOAD) {
    onProgress("Přepisuji nahrávku…");
    return transcribe(blob);
  }
  onProgress("Připravuji dlouhou nahrávku…");
  const parts = await splitToWav(blob, CHUNK_SECONDS);
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    onProgress(`Přepisuji část ${i + 1} z ${parts.length}…`);
    out.push(await transcribe(parts[i]));
  }
  return out.join(" ");
}

async function splitToWav(blob, seconds) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ac = new Ctx();
  const decoded = await ac.decodeAudioData(await blob.arrayBuffer());
  ac.close();
  const rate = 16000;
  const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * rate), rate);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const mono = (await off.startRendering()).getChannelData(0);
  const step = seconds * rate;
  const parts = [];
  for (let i = 0; i < mono.length; i += step) parts.push(encodeWav(mono.subarray(i, i + step), rate));
  return parts;
}

function encodeWav(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o, s) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  w(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

// ---------- zápis ze schůzky ----------

const NOTES_SYSTEM = `Jsi pečlivý zapisovatel porad. Dostaneš automatický přepis řeči ze schůzky nebo telefonního hovoru, v češtině nebo slovenštině (i střídavě). Přepis může obsahovat chyby rozpoznávání; mluvčí mohou být označeni „Mluvčí 1“, „Mluvčí 2“ atd. – pokud z obsahu vyplyne jejich jméno nebo role, použij ho. Zápis piš vždy česky.

Vytvoř z něj podrobný zápis v češtině. Výstup bude vložen přímo do e-mailu, proto piš prostý text bez Markdownu (žádné #, ** ani tabulky); nadpisy piš VELKÝMI PÍSMENY, odrážky pomlčkou.

Struktura:
ZÁPIS ZE SCHŮZKY
Datum a čas, místo, délka (z údajů níže)

ÚČASTNÍCI – jména nebo role, pokud v přepisu zazní; jinak „neuvedeno“
SHRNUTÍ – 3 až 6 vět o tom, o čem schůzka byla a k čemu se došlo
PROJEDNANÁ TÉMATA – podrobně, každé téma s jeho podstatnými body
ROZHODNUTÍ
ÚKOLY – kdo, co, do kdy (pokud zazní)
TERMÍNY, ČÍSLA A ČÁSTKY – vše konkrétní, co zaznělo
OTEVŘENÉ OTÁZKY

Sekce, ke kterým přepis nic neobsahuje, vynech. Pokud jde o krátkou poznámku nebo hovor, přizpůsob rozsah. Nevymýšlej nic, co v přepisu není; nejasná místa označ [nejasné].`;

function notesInput(rec) {
  const info = [
    `Datum a čas: ${new Date(rec.created).toLocaleString("cs-CZ")}`,
    `Místo: ${rec.place || "neuvedeno"}`,
    `Délka: ${rec.duration ? clock(rec.duration) : "neuvedeno"}`,
  ].join("\n");
  return `${info}\n\n<prepis>\n${rec.transcript}\n</prepis>`;
}

async function makeNotesGemini(rec, onText) {
  const st = loadSettings();
  if (!st.geminiKey) throw new Error("Chybí Gemini API klíč – doplňte ho v Nastavení.");
  const model = st.geminiModel || DEFAULTS.geminiModel;
  let res;
  try {
    res = await fetch(`${GEMINI_URL}/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers: { "x-goog-api-key": st.geminiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: NOTES_SYSTEM }] },
        contents: [{ role: "user", parts: [{ text: notesInput(rec) }] }],
        generationConfig: { maxOutputTokens: 32768 },
      }),
    });
  } catch {
    throw new Error("Zápis selhal: nejste připojeni k internetu.");
  }
  if (!res.ok) {
    const body = await res.text();
    if (/API_KEY_INVALID|API key not valid/.test(body)) throw new Error("Zápis selhal: neplatný Gemini klíč.");
    if (res.status === 429) throw new Error("Zápis selhal: vyčerpaný bezplatný limit Gemini, zkuste to později.");
    if (res.status === 404) throw new Error(`Zápis selhal: model „${model}“ neexistuje – změňte ho v Nastavení.`);
    throw new Error(`Zápis selhal (${res.status}): ${body.slice(0, 200)}`);
  }
  // Odpověď chodí jako SSE: řádky „data: {json}“.
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  let text = "";
  let finish = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const cand = JSON.parse(line.slice(5)).candidates?.[0];
      for (const p of cand?.content?.parts || []) {
        if (p.text && !p.thought) {
          text += p.text;
          onText(text);
        }
      }
      if (cand?.finishReason) finish = cand.finishReason;
    }
  }
  if (!text) {
    throw new Error(/SAFETY|PROHIBITED/.test(finish) ? "Gemini odmítl tento přepis zpracovat." : "Gemini nevrátil žádný text.");
  }
  return text.trim();
}

async function makeNotesClaude(rec, onText) {
  const st = loadSettings();
  if (!st.anthropicKey) throw new Error("Chybí Anthropic API klíč – doplňte ho v Nastavení.");
  const { default: Anthropic } = await import(SDK_URL);
  const client = new Anthropic({ apiKey: st.anthropicKey, dangerouslyAllowBrowser: true });
  try {
    const stream = client.beta.messages.stream({
      model: NOTES_MODEL,
      max_tokens: 64000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      system: NOTES_SYSTEM,
      messages: [{ role: "user", content: notesInput(rec) }],
    });
    let text = "";
    stream.on("text", (delta) => {
      text += delta;
      onText(text);
    });
    const msg = await stream.finalMessage();
    if (msg.stop_reason === "refusal") throw new Error("Model odmítl tento přepis zpracovat.");
    return msg.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new Error("Zápis selhal: neplatný Anthropic klíč.");
    if (err instanceof Anthropic.RateLimitError) throw new Error("Zápis selhal: příliš mnoho požadavků, zkuste to za chvíli.");
    if (err instanceof Anthropic.APIConnectionError) throw new Error("Zápis selhal: nejste připojeni k internetu.");
    if (err instanceof Anthropic.APIError) throw new Error(`Zápis selhal (${err.status}): ${err.message}`);
    throw err;
  }
}

function makeNotes(rec, onText) {
  return loadSettings().notesProvider === "anthropic" ? makeNotesClaude(rec, onText) : makeNotesGemini(rec, onText);
}

// ---------- zpracování nahrávky ----------

const processing = new Set();

// liveText = průběžný přepis z nahrávání. U Groq se rovnou použije (šetří
// bezplatný limit); u ElevenLabs se celá nahrávka přepíše znovu s mluvčími
// a průběžný přepis slouží jen jako záloha.
async function processRecording(rec, liveText = "") {
  if (processing.has(rec.id)) return;
  processing.add(rec.id);
  const update = async (patch) => {
    Object.assign(rec, patch);
    await putRec(rec);
    refresh(rec);
  };
  try {
    const st = loadSettings();
    await update({ status: "processing", error: "" });
    if (liveText && st.sttProvider !== "elevenlabs") {
      await update({ transcript: liveText });
    } else {
      try {
        await update({ transcript: await transcribeFile(rec.audio, (p) => update({ progress: p })) });
      } catch (err) {
        if (!liveText) throw err;
        await update({ transcript: liveText });
        toast("Finální přepis selhal, použiji průběžný.");
      }
    }
    if (!rec.transcript) throw new Error("V nahrávce nebyla rozpoznána žádná řeč.");
    if (st.notesProvider === "claude-manual") {
      await update({ status: "manual", progress: "" });
      return;
    }
    await update({ progress: "Píšu zápis ze schůzky…", notes: "" });
    let last = 0;
    const notes = await makeNotes(rec, (t) => {
      rec.notes = t;
      if (Date.now() - last > 150) {
        last = Date.now();
        refresh(rec);
      }
    });
    await update({ notes, status: "done", progress: "" });
    if (currentId === rec.id) toast("Zápis je hotový.");
  } catch (err) {
    await update({ status: "error", progress: "", error: err.message || String(err) });
  } finally {
    processing.delete(rec.id);
    refresh(rec);
  }
}

// ---------- nahrávání ----------

const MIME = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"].find(
  (t) => window.MediaRecorder && MediaRecorder.isTypeSupported?.(t),
) || "";

let session = null;

function newRecorder(stream) {
  return new MediaRecorder(stream, MIME ? { mimeType: MIME } : undefined);
}

async function startRecording() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch {
    toast("Bez přístupu k mikrofonu nelze nahrávat. Povolte ho v nastavení Safari.");
    return;
  }
  const started = new Date();
  const rec = {
    id: crypto.randomUUID(),
    created: started.toISOString(),
    name: stamp(started),
    place: "",
    lat: null,
    lon: null,
    mime: MIME,
    duration: 0,
    transcript: "",
    notes: "",
    status: "recording",
    source: "mic",
  };
  const s = { rec, stream, chunks: [], texts: [], segIndex: 0, failed: false, pending: Promise.resolve(), startedAt: Date.now() };
  session = s;

  s.main = newRecorder(stream);
  s.main.ondataavailable = (e) => e.data.size && s.chunks.push(e.data);
  s.main.start(1000);
  startSegment(s);
  s.segTimer = setInterval(() => rotateSegment(s), SEGMENT_SECONDS * 1000);
  s.tick = setInterval(() => ($("#timer").textContent = clock((Date.now() - s.startedAt) / 1000)), 500);

  // Hovor nebo jiná aplikace může mikrofon odebrat – uložíme, co máme.
  const track = stream.getAudioTracks()[0];
  track.addEventListener("ended", () => session === s && stopRecording("Nahrávání bylo přerušeno (např. hovorem). Uloženo."));
  s.main.onerror = () => session === s && stopRecording("Nahrávání bylo přerušeno. Uloženo.");

  requestWakeLock();
  setRecordingUI(true);
  $("#recName").textContent = rec.name;
  $("#live").textContent = sttKey() ? "Průběžný přepis se objeví za pár vteřin…" : "Průběžný přepis je vypnutý – chybí klíč pro přepis.";

  getPosition().then(async (c) => {
    if (!c) return;
    rec.lat = c.latitude;
    rec.lon = c.longitude;
    rec.place = await placeName(c);
    rec.name = stamp(started) + (rec.place ? ` – ${rec.place}` : "");
    if (session === s) $("#recName").textContent = rec.name;
  });
}

function startSegment(s) {
  const r = newRecorder(s.stream);
  const parts = [];
  const idx = s.segIndex++;
  r.ondataavailable = (e) => e.data.size && parts.push(e.data);
  r.onstop = () => {
    const blob = new Blob(parts, { type: r.mimeType || MIME });
    if (blob.size > 2000) queueSegment(s, idx, blob);
  };
  r.start();
  s.seg = r;
}

function rotateSegment(s) {
  const old = s.seg;
  startSegment(s);
  old.stop();
}

function queueSegment(s, idx, blob) {
  if (!sttKey()) {
    s.failed = true;
    return;
  }
  s.pending = s.pending.then(async () => {
    try {
      s.texts[idx] = await transcribe(blob);
    } catch (err) {
      s.failed = true;
      if (session === s) toast(err.message);
    }
    if (session === s) {
      const live = $("#live");
      live.textContent = s.texts.filter(Boolean).join(" ") || "…";
      live.scrollTop = live.scrollHeight;
    }
  });
}

async function stopRecording(message) {
  const s = session;
  if (!s) return;
  session = null;
  clearInterval(s.segTimer);
  clearInterval(s.tick);
  const stopped = (r) => (r.state === "inactive" ? Promise.resolve() : new Promise((res) => {
    r.addEventListener("stop", res, { once: true });
    r.stop();
  }));
  await Promise.all([stopped(s.seg), stopped(s.main)]);
  s.stream.getTracks().forEach((t) => t.stop());
  releaseWakeLock();
  setRecordingUI(false);

  const rec = s.rec;
  rec.audio = new Blob(s.chunks, { type: s.main.mimeType || MIME });
  rec.mime = rec.audio.type;
  rec.duration = (Date.now() - s.startedAt) / 1000;
  rec.status = "processing";
  rec.progress = "Dokončuji přepis…";
  await putRec(rec);
  await renderList();
  openDetail(rec.id);
  if (message) toast(message);

  await s.pending;
  const live = s.failed ? "" : s.texts.filter(Boolean).join(" ");
  processRecording(rec, live);
}

function setRecordingUI(on) {
  $("#btnRecord").classList.toggle("on", on);
  $("#btnRecord").setAttribute("aria-label", on ? "Ukončit nahrávání" : "Spustit nahrávání");
  $("#recHint").hidden = !on;
  $("#live").hidden = !on;
  if (!on) {
    $("#timer").textContent = "00:00";
    $("#recName").textContent = "Stiskněte pro nahrávání";
  }
}

let wakeLock = null;
async function requestWakeLock() {
  try {
    wakeLock = await navigator.wakeLock?.request("screen");
  } catch {
    wakeLock = null;
  }
}
function releaseWakeLock() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}
document.addEventListener("visibilitychange", () => {
  if (session && document.visibilityState === "visible") requestWakeLock();
});

// ---------- import souboru ----------

async function importFile(file) {
  const when = new Date(file.lastModified || Date.now());
  const base = file.name.replace(/\.[^.]+$/, "");
  const rec = {
    id: crypto.randomUUID(),
    created: when.toISOString(),
    name: `${stamp(when)} – ${base}`,
    place: "",
    mime: file.type || "audio/mp4",
    duration: 0,
    transcript: "",
    notes: "",
    status: "processing",
    progress: "Načítám…",
    source: "import",
    audio: file,
  };
  rec.duration = await audioDuration(file);
  await putRec(rec);
  await renderList();
  openDetail(rec.id);
  processRecording(rec);
}

function audioDuration(blob) {
  return new Promise((resolve) => {
    const a = new Audio();
    const url = URL.createObjectURL(blob);
    const done = (d) => {
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(d) ? d : 0);
    };
    a.preload = "metadata";
    a.onloadedmetadata = () => done(a.duration);
    a.onerror = () => done(0);
    a.src = url;
  });
}

// ---------- seznam a detail ----------

const STATUS_LABEL = { processing: "zpracovává se…", error: "chyba", recording: "nahrává se", manual: "čeká na zápis" };

async function renderList() {
  const recs = (await allRecs()).sort((a, b) => b.created.localeCompare(a.created));
  $("#empty").hidden = recs.length > 0;
  $("#list").innerHTML = recs.map((r) => `
    <li data-id="${r.id}">
      <div class="name">${esc(r.name)}</div>
      <div class="sub">${r.duration ? clock(r.duration) : ""}${r.source === "import" ? " · import" : ""}${STATUS_LABEL[r.status] ? " · " + STATUS_LABEL[r.status] : ""}</div>
    </li>`).join("");
}

// Otevřená nahrávka je držená v paměti, aby tlačítka (sdílení, schránka)
// běžela hned v rámci klepnutí – Safari to po čekání na databázi nedovolí.
let currentId = null;
let currentRec = null;
let audioUrl = null;

async function openDetail(id) {
  const rec = await getRec(id);
  if (!rec) return;
  currentId = id;
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = rec.audio ? URL.createObjectURL(rec.audio) : null;
  $("#dAudio").src = audioUrl || "";
  showTab("notes");
  renderDetail(rec);
  $("#detail").hidden = false;
  $("#detail").scrollTop = 0;
}

function closeDetail() {
  currentId = null;
  currentRec = null;
  $("#detail").hidden = true;
  $("#dAudio").pause();
  renderList();
}

const STATUS_TEXT = {
  manual: "Přepis je hotový. Klepněte na 1. – přepis se zkopíruje a otevře se Claude. Tam ho vložte, a hotový zápis zkopírujte zpět tlačítkem 2.",
};

function renderDetail(rec) {
  currentRec = rec;
  $("#dTitle").textContent = rec.name;
  const created = new Date(rec.created);
  $("#dMeta").textContent = [created.toLocaleString("cs-CZ"), rec.place, rec.duration ? clock(rec.duration) : ""].filter(Boolean).join(" · ");
  const status = $("#dStatus");
  const showStatus = ["processing", "error", "manual"].includes(rec.status);
  status.hidden = !showStatus;
  status.classList.toggle("error", rec.status === "error");
  status.textContent = rec.status === "error" ? rec.error : STATUS_TEXT[rec.status] || rec.progress || "Zpracovávám…";
  const manual = !!rec.transcript && (rec.status === "manual" || loadSettings().notesProvider === "claude-manual");
  $("#manualBox").hidden = !manual;
  $("#dNotes").textContent = rec.notes || (rec.status === "processing" ? "Zápis se připravuje…" : "Zápis zatím není.");
  $("#dTranscript").textContent = rec.transcript || "Přepis zatím není.";
  const busy = processing.has(rec.id);
  $("#btnRedo").disabled = busy;
  $("#btnEmail").disabled = !rec.notes || busy;
  $("#btnCopy").disabled = !rec.notes;
}

function refresh(rec) {
  if (currentId === rec.id) renderDetail(rec);
  else renderList();
}

function showTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  $("#dNotes").hidden = name !== "notes";
  $("#dTranscript").hidden = name !== "transcript";
}

function emailRec(rec) {
  const to = loadSettings().email;
  const subject = `Zápis: ${rec.name}`;
  location.href = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(rec.notes)}`;
}

async function shareRec(rec) {
  const data = { title: rec.name, text: rec.notes || rec.transcript || rec.name };
  if (rec.audio) {
    const file = new File([rec.audio], fileNameFor(rec), { type: rec.audio.type || rec.mime });
    if (navigator.canShare?.({ files: [file] })) data.files = [file];
  }
  if (!navigator.share) return toast("Sdílení tento prohlížeč neumí.");
  try {
    await navigator.share(data);
  } catch (err) {
    if (err.name !== "AbortError") toast("Sdílení se nepodařilo.");
  }
}

function downloadRec(rec) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(rec.audio);
  a.download = fileNameFor(rec);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function openInClaude(rec) {
  navigator.clipboard.writeText(`${NOTES_SYSTEM}\n\n${notesInput(rec)}`).then(
    () => toast("Zkopírováno. V Claude dlouze podržte pole zprávy a dejte Vložit."),
    () => toast("Kopírování se nepodařilo."),
  );
  window.open("https://claude.ai/new", "_blank");
}

async function pasteNotes(rec) {
  let text = "";
  try {
    text = (await navigator.clipboard.readText()).trim();
  } catch {
    return toast("Schránku se nepodařilo přečíst.");
  }
  if (!text || text.includes("<prepis>")) return toast("Ve schránce není hotový zápis. V Claude ho nejdřív zkopírujte.");
  Object.assign(rec, { notes: text, status: "done" });
  await putRec(rec);
  refresh(rec);
  toast("Zápis vložen.");
}

// ---------- události ----------

function bind() {
  $("#btnRecord").addEventListener("click", () => (session ? stopRecording() : startRecording()));
  $("#fileImport").addEventListener("change", (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (f) importFile(f);
  });
  $("#list").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-id]");
    if (li) openDetail(li.dataset.id);
  });
  $("#btnBack").addEventListener("click", closeDetail);
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));

  $("#btnEmail").addEventListener("click", () => currentRec?.notes && emailRec(currentRec));
  $("#btnShare").addEventListener("click", () => currentRec && shareRec(currentRec));
  $("#btnCopy").addEventListener("click", () => {
    navigator.clipboard.writeText(currentRec.notes).then(
      () => toast("Zápis zkopírován."),
      () => toast("Kopírování se nepodařilo."),
    );
  });
  $("#btnClaude").addEventListener("click", () => currentRec && openInClaude(currentRec));
  $("#btnPaste").addEventListener("click", () => currentRec && pasteNotes(currentRec));
  $("#btnDownload").addEventListener("click", () => currentRec?.audio && downloadRec(currentRec));
  $("#btnRedo").addEventListener("click", () => currentRec && processRecording(currentRec));
  $("#btnDelete").addEventListener("click", async () => {
    const rec = currentRec;
    if (rec && confirm(`Smazat nahrávku „${rec.name}“ včetně zápisu?`)) {
      await deleteRec(rec.id);
      closeDetail();
    }
  });

  const dlg = $("#settings");
  const form = $("#settingsForm");
  const syncFields = () => {
    form.querySelectorAll("[data-show]").forEach((el) => {
      const [name, value] = el.dataset.show.split("=");
      el.hidden = form.elements[name].value !== value;
    });
  };
  form.addEventListener("change", syncFields);
  $("#btnSettings").addEventListener("click", () => {
    const st = loadSettings();
    for (const k of Object.keys(DEFAULTS)) form.elements[k].value = st[k];
    syncFields();
    dlg.showModal();
  });
  dlg.addEventListener("close", () => {
    if (dlg.returnValue !== "save") return;
    const st = {};
    for (const k of Object.keys(DEFAULTS)) st[k] = form.elements[k].value.trim();
    saveSettings(st);
    toast("Nastavení uloženo.");
  });
}

async function init() {
  db = await openDB();
  bind();
  // Nahrávky přerušené zavřením aplikace dokončíme, ostatní nedokončené označíme.
  for (const rec of await allRecs()) {
    if (rec.status === "processing" || rec.status === "recording") {
      if (rec.audio && rec.audio.size) processRecording(rec);
      else await putRec({ ...rec, status: "error", error: "Nahrávání bylo přerušeno, zvuk se neuložil." });
    }
  }
  await renderList();
  if (missingKeys()) toast("Nejdřív v Nastavení (⚙︎) vložte API klíče.");
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}

init();
