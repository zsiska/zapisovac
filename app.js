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

// recordings: nahrávky; chunks: kousky zvuku ukládané během nahrávání,
// aby se při přerušení (zamčení, zavření aplikace) nic neztratilo.
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("zapisovac", 2);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains("recordings")) d.createObjectStore("recordings", { keyPath: "id" });
      if (!d.objectStoreNames.contains("chunks")) {
        d.createObjectStore("chunks", { keyPath: "id", autoIncrement: true }).createIndex("recId", "recId");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function store(mode, fn, name = "recordings") {
  return new Promise((resolve, reject) => {
    const t = db.transaction(name, mode);
    const req = fn(t.objectStore(name));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}

const putRec = (rec) => store("readwrite", (s) => s.put(rec));
const getRec = (id) => store("readonly", (s) => s.get(id));
const allRecs = () => store("readonly", (s) => s.getAll());
const addChunk = (recId, data) => store("readwrite", (s) => s.add({ recId, data }), "chunks");
const chunksFor = (recId) => store("readonly", (s) => s.index("recId").getAll(recId), "chunks");
const deleteChunks = (recId) => store("readwrite", (s) => {
  s.index("recId").openKeyCursor(IDBKeyRange.only(recId)).onsuccess = (e) => {
    const cur = e.target.result;
    if (cur) {
      s.delete(cur.primaryKey);
      cur.continue();
    }
  };
}, "chunks");

async function deleteRec(id) {
  await deleteChunks(id);
  await store("readwrite", (s) => s.delete(id));
}

// Nahrávka může mít víc částí (pokračování po přerušení). Starší záznamy mají jen `audio`.
function recParts(rec) {
  return rec.parts || (rec.audio ? [rec.audio] : []);
}

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

function fileNameFor(rec, i = 0, count = 1) {
  const part = count > 1 ? ` (část ${i + 1})` : "";
  return rec.name.replace(/[\\/:*?"<>|]/g, "-") + part + "." + extFor(rec.mime || "");
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

// Celá nahrávka (všechny její části): ElevenLabs vezme cokoli najednou,
// pro Groq se velký soubor rozdělí na kusy ve WAV (16 kHz mono).
async function transcribeFile(parts, onProgress) {
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const of = parts.length > 1 ? ` (část ${i + 1} z ${parts.length})` : "";
    out.push(await transcribeBlob(parts[i], (p) => onProgress(p + of)));
  }
  return out.filter(Boolean).join("\n\n");
}

async function transcribeBlob(blob, onProgress) {
  if (loadSettings().sttProvider === "elevenlabs") {
    onProgress("Přepisuji nahrávku a rozlišuji mluvčí…");
    return transcribe(blob, { diarize: true });
  }
  if (blob.size <= MAX_UPLOAD) {
    onProgress("Přepisuji nahrávku…");
    return transcribe(blob);
  }
  onProgress("Připravuji dlouhou nahrávku…");
  const chunks = await splitToWav(blob, CHUNK_SECONDS);
  const out = [];
  for (let i = 0; i < chunks.length; i++) {
    onProgress(`Přepisuji úsek ${i + 1} z ${chunks.length}…`);
    out.push(await transcribe(chunks[i]));
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

const GEMINI_FALLBACK = "gemini-flash-latest";
const RETRY_DELAYS = [3, 8, 15]; // sekundy mezi pokusy při přetížení

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

function geminiRequest(st, model, rec) {
  return fetch(`${GEMINI_URL}/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
    method: "POST",
    headers: { "x-goog-api-key": st.geminiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: NOTES_SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: notesInput(rec) }] }],
      generationConfig: { maxOutputTokens: 32768 },
    }),
  });
}

// Přetížení (503) nebo dočasná chyba serveru: zkusit znovu s prodlevou,
// nakonec jednou záložní model. Uživatel vidí průběh v detailu nahrávky.
async function geminiWithRetry(st, model, rec) {
  const say = (t) => {
    rec.progress = t;
    refresh(rec);
  };
  const busy = (code) => code >= 500 && code <= 504;
  let res;
  for (let i = 0; ; i++) {
    try {
      res = await geminiRequest(st, model, rec);
    } catch {
      throw new Error("Zápis selhal: nejste připojeni k internetu.");
    }
    if (!busy(res.status) || i >= RETRY_DELAYS.length) break;
    say(`Gemini je přetížený, zkouším znovu za ${RETRY_DELAYS[i]} s (pokus ${i + 2}/${RETRY_DELAYS.length + 1})…`);
    await sleep(RETRY_DELAYS[i]);
    say("Píšu zápis ze schůzky…");
  }
  if (busy(res.status) && model !== GEMINI_FALLBACK) {
    say("Gemini je přetížený, zkouším záložní model…");
    try {
      const alt = await geminiRequest(st, GEMINI_FALLBACK, rec);
      if (alt.ok) {
        say("Píšu zápis ze schůzky…");
        return alt;
      }
    } catch {}
  }
  return res;
}

async function makeNotesGemini(rec, onText) {
  const st = loadSettings();
  if (!st.geminiKey) throw new Error("Chybí Gemini API klíč – doplňte ho v Nastavení.");
  const model = st.geminiModel || DEFAULTS.geminiModel;
  const res = await geminiWithRetry(st, model, rec);
  if (!res.ok) {
    const body = await res.text();
    if (/API_KEY_INVALID|API key not valid/.test(body)) throw new Error("Zápis selhal: neplatný Gemini klíč.");
    if (res.status === 429) throw new Error("Zápis selhal: vyčerpaný bezplatný limit Gemini. Zkuste to později tlačítkem Zpracovat znovu.");
    if (res.status === 404) throw new Error(`Zápis selhal: model „${model}“ neexistuje – změňte ho v Nastavení.`);
    if (res.status >= 500) throw new Error("Zápis se nepodařil: Gemini je teď přetížený. Přepis je uložený – za pár minut klepněte na Zpracovat znovu, nebo v Nastavení přepněte na Aplikaci Claude.");
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

// rec.live = průběžný přepis z nahrávání. U Groq se rovnou použije (šetří
// bezplatný limit); u ElevenLabs se celá nahrávka přepíše znovu s mluvčími
// a průběžný přepis slouží jen jako záloha. redo = vždy přepsat celý zvuk.
async function processRecording(rec, { redo = false, notesOnly = false } = {}) {
  if (processing.has(rec.id)) return;
  processing.add(rec.id);
  const update = async (patch) => {
    Object.assign(rec, patch);
    await putRec(rec);
    refresh(rec);
  };
  const liveText = !redo && !rec.liveFailed ? rec.live || "" : "";
  try {
    const st = loadSettings();
    await update({ status: "processing", error: "" });
    if (notesOnly && rec.transcript) {
      // Přepis už je hotový, selhal jen zápis – přepis neopakujeme.
    } else if (liveText && st.sttProvider !== "elevenlabs") {
      await update({ transcript: liveText });
    } else {
      try {
        await update({ transcript: await transcribeFile(recParts(rec), (p) => update({ progress: p })) });
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

// existing = pokračování v přerušené nahrávce (přidá se další část).
async function startRecording(existing) {
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
  const rec = existing || {
    id: crypto.randomUUID(),
    created: started.toISOString(),
    name: stamp(started),
    place: "",
    lat: null,
    lon: null,
    mime: MIME,
    duration: 0,
    parts: [],
    live: "",
    liveFailed: false,
    transcript: "",
    notes: "",
    source: "mic",
  };
  Object.assign(rec, { status: "recording", progress: "", error: "" });
  await putRec(rec);

  const s = {
    rec,
    stream,
    chunks: [],
    texts: [],
    liveBase: rec.live || "",
    segIndex: 0,
    failed: false,
    pending: Promise.resolve(),
    startedAt: Date.now(),
  };
  session = s;

  // Každé 2 s se kousek zvuku uloží do databáze.
  s.main = newRecorder(stream);
  s.main.ondataavailable = (e) => {
    if (!e.data.size) return;
    s.chunks.push(e.data);
    addChunk(rec.id, e.data).catch(() => {});
  };
  s.main.start(2000);
  startSegment(s);
  s.segTimer = setInterval(() => rotateSegment(s), SEGMENT_SECONDS * 1000);
  s.tick = setInterval(() => {
    const t = clock(rec.duration + (Date.now() - s.startedAt) / 1000);
    $("#timer").textContent = t;
    $("#darkTimer").textContent = t;
  }, 500);

  // Hovor, zamčení nebo jiná aplikace může mikrofon odebrat – uložíme, co máme.
  s.track = stream.getAudioTracks()[0];
  s.track.addEventListener("ended", () => session === s && finishRecording(s, true));
  s.main.onerror = () => session === s && finishRecording(s, true);

  setRecordingUI(true);
  $("#recName").textContent = rec.name;
  showLive(s);
  keepAwake();

  if (!existing) {
    getPosition().then(async (c) => {
      if (!c) return;
      rec.lat = c.latitude;
      rec.lon = c.longitude;
      rec.place = await placeName(c);
      rec.name = stamp(started) + (rec.place ? ` – ${rec.place}` : "");
      if (session === s) {
        $("#recName").textContent = rec.name;
        putRec(rec).catch(() => {});
      }
    });
  }
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

function liveText(s) {
  return [s.liveBase, s.texts.filter(Boolean).join(" ")].filter(Boolean).join("\n\n");
}

function showLive(s) {
  const live = $("#live");
  if (!sttKey()) live.textContent = "Průběžný přepis je vypnutý – chybí klíč pro přepis.";
  else live.textContent = liveText(s) || "Průběžný přepis se objeví za pár vteřin…";
  live.scrollTop = live.scrollHeight;
}

function queueSegment(s, idx, blob) {
  if (!sttKey()) {
    s.failed = true;
    return;
  }
  s.pending = s.pending.then(async () => {
    try {
      s.texts[idx] = await transcribe(blob);
      s.rec.live = liveText(s);
      if (session === s) putRec(s.rec).catch(() => {});
    } catch (err) {
      s.failed = true;
      if (session === s) toast(err.message);
    }
    if (session === s) showLive(s);
  });
}

// interrupted = přerušeno systémem (zamčení, hovor); nahrávka čeká na Pokračovat.
async function finishRecording(s, interrupted) {
  if (session !== s) return;
  session = null;
  clearInterval(s.segTimer);
  clearInterval(s.tick);
  const stopped = (r) => (r.state === "inactive" ? Promise.resolve() : new Promise((res) => {
    r.addEventListener("stop", res, { once: true });
    try {
      r.stop();
    } catch {
      res();
    }
  }));
  await Promise.all([stopped(s.seg), stopped(s.main)]);
  s.stream.getTracks().forEach((t) => t.stop());
  releaseAwake();
  setRecordingUI(false);

  const rec = s.rec;
  const blob = new Blob(s.chunks, { type: s.main.mimeType || MIME });
  if (blob.size) {
    rec.parts = [...recParts(rec), blob];
    delete rec.audio;
    rec.mime = blob.type;
  }
  rec.duration += (Date.now() - s.startedAt) / 1000;
  rec.status = interrupted ? "interrupted" : "processing";
  rec.progress = "Dokončuji přepis…";
  await putRec(rec);
  await deleteChunks(rec.id);
  await renderList();
  // Dokud doběhne přepis posledního úseku, je nahrávka „zaneprázdněná“
  // (nejde pokračovat ani zpracovat).
  processing.add(rec.id);
  openDetail(rec.id, rec);
  if (interrupted) toast("Nahrávání se přerušilo. Zvuk je uložený – můžete pokračovat.");

  await s.pending;
  rec.live = liveText(s);
  rec.liveFailed = rec.liveFailed || s.failed;
  rec.progress = "";
  await putRec(rec);
  processing.delete(rec.id);
  refresh(rec);
  if (!interrupted) processRecording(rec);
}

function setRecordingUI(on) {
  $("#btnRecord").classList.toggle("on", on);
  $("#btnRecord").setAttribute("aria-label", on ? "Ukončit nahrávání" : "Spustit nahrávání");
  $("#recHint").hidden = !on;
  $("#btnDark").hidden = !on;
  $("#live").hidden = !on;
  if (!on) {
    $("#dark").hidden = true;
    $("#timer").textContent = "00:00";
    $("#recName").textContent = "Stiskněte pro nahrávání";
  }
}

// Udržení rozsvíceného displeje. Když to systém nedovolí, upozorníme.
let wakeLock = null;
async function keepAwake() {
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => {
      wakeLock = null;
    });
  } catch {
    wakeLock = null;
  }
  const hint = $("#recHint");
  hint.classList.toggle("warn", !wakeLock);
  hint.textContent = wakeLock
    ? "Displej zůstane rozsvícený. Telefon nezamykejte tlačítkem."
    : "Pozor: telefon se může sám zamknout a nahrávání se přeruší. Nastavte Automatický zámek → Nikdy (viz návod níže).";
}
function releaseAwake() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

// Po návratu z pozadí: zkontrolovat, jestli nahrávání ještě běží.
document.addEventListener("visibilitychange", () => {
  const s = session;
  if (!s || document.visibilityState !== "visible") return;
  if (s.track.readyState === "ended" || s.main.state !== "recording") finishRecording(s, true);
  else if (!wakeLock) keepAwake();
});

// Aplikace byla zavřena uprostřed nahrávání: složit uložené kousky do nové části.
async function recoverRecording(rec) {
  const chunks = await chunksFor(rec.id);
  if (chunks.length) {
    const blob = new Blob(chunks.map((c) => c.data), { type: rec.mime || MIME });
    rec.parts = [...recParts(rec), blob];
    delete rec.audio;
    rec.duration += await audioDuration(blob);
  }
  rec.status = recParts(rec).length ? "interrupted" : "error";
  rec.error = rec.status === "error" ? "Nahrávání bylo přerušeno, zvuk se neuložil." : "";
  await putRec(rec);
  await deleteChunks(rec.id);
}

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
    parts: [file],
    transcript: "",
    notes: "",
    status: "processing",
    progress: "Načítám…",
    source: "import",
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

const STATUS_LABEL = {
  processing: "zpracovává se…",
  error: "chyba",
  recording: "nahrává se",
  manual: "čeká na zápis",
  interrupted: "přerušeno",
};

async function renderList() {
  const recs = (await allRecs()).sort((a, b) => b.created.localeCompare(a.created));
  $("#empty").hidden = recs.length > 0;
  $("#list").innerHTML = recs.map((r) => {
    const imported = r.source === "import";
    const sub = [r.duration ? clock(r.duration) : "", imported ? "import" : ""].filter(Boolean).join(" · ");
    const chip = STATUS_LABEL[r.status]
      ? `<span class="chip s-${r.status}">${STATUS_LABEL[r.status]}</span>`
      : r.notes ? `<span class="chip s-done"><svg><use href="#i-check"/></svg>zápis</span>` : "";
    return `
    <li data-id="${r.id}">
      <span class="item-icon${imported ? " imp" : ""}"><svg><use href="#i-${imported ? "file" : "mic"}"/></svg></span>
      <div class="item-body">
        <div class="name">${esc(r.name)}</div>
        ${sub || chip ? `<div class="sub">${sub ? `<span>${sub}</span>` : ""}${chip}</div>` : ""}
      </div>
      <svg class="chev"><use href="#i-chev"/></svg>
    </li>`;
  }).join("");
}

// Otevřená nahrávka je držená v paměti, aby tlačítka (sdílení, schránka)
// běžela hned v rámci klepnutí – Safari to po čekání na databázi nedovolí.
let currentId = null;
let currentRec = null;
let audioUrls = [];

// rec: nahrávka už držená v paměti (aby se změny v ní hned projevily v detailu).
async function openDetail(id, rec) {
  rec = rec || (await getRec(id));
  if (!rec) return;
  currentId = id;
  renderAudio(rec);
  showTab("notes");
  renderDetail(rec);
  $("#detail").hidden = false;
  $("#detail").scrollTop = 0;
}

function renderAudio(rec) {
  audioUrls.forEach((u) => URL.revokeObjectURL(u));
  const parts = recParts(rec);
  audioUrls = parts.map((p) => URL.createObjectURL(p));
  $("#dAudios").innerHTML = audioUrls.map((u, i) => `
    ${parts.length > 1 ? `<div class="muted">Část ${i + 1}</div>` : ""}
    <audio controls preload="metadata" src="${u}"></audio>`).join("");
}

function closeDetail() {
  currentId = null;
  currentRec = null;
  $("#detail").hidden = true;
  document.querySelectorAll("#dAudios audio").forEach((a) => a.pause());
  renderList();
}

const STATUS_TEXT = {
  manual: "Přepis je hotový. Klepněte na 1. – přepis se zkopíruje a otevře se Claude. Tam ho vložte, a hotový zápis zkopírujte zpět tlačítkem 2.",
  interrupted: "Nahrávání se přerušilo (zamčení telefonu nebo hovor). Zvuk do té chvíle je uložený. Můžete pokračovat ve stejné nahrávce, nebo ji dokončit a zpracovat.",
};

function renderDetail(rec) {
  currentRec = rec;
  $("#dTitle").textContent = rec.name;
  const created = new Date(rec.created);
  $("#dMeta").textContent = [created.toLocaleString("cs-CZ"), rec.place, rec.duration ? clock(rec.duration) : ""].filter(Boolean).join(" · ");
  const status = $("#dStatus");
  status.hidden = !["processing", "error", "manual", "interrupted"].includes(rec.status);
  status.classList.toggle("error", rec.status === "error");
  status.textContent = rec.status === "error" ? rec.error : STATUS_TEXT[rec.status] || rec.progress || "Zpracovávám…";
  const busy = processing.has(rec.id);
  const canContinue = rec.source === "mic" && !busy && !session && rec.status !== "processing";
  $("#resumeBox").hidden = !canContinue;
  $("#btnFinish").hidden = rec.status !== "interrupted";
  $("#btnContinue").classList.toggle("secondary", rec.status !== "interrupted");
  const manual = !!rec.transcript && (rec.status === "manual" || loadSettings().notesProvider === "claude-manual");
  $("#manualBox").hidden = !manual;
  $("#dNotes").textContent = rec.notes || (rec.status === "processing" ? "Zápis se připravuje…" : "Zápis zatím není.");
  $("#dTranscript").textContent = rec.transcript || rec.live || "Přepis zatím není.";
  $("#btnRedo").disabled = busy || rec.status === "interrupted";
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
  const parts = recParts(rec);
  const files = parts.map((p, i) => new File([p], fileNameFor(rec, i, parts.length), { type: p.type || rec.mime }));
  if (files.length && navigator.canShare?.({ files })) data.files = files;
  if (!navigator.share) return toast("Sdílení tento prohlížeč neumí.");
  try {
    await navigator.share(data);
  } catch (err) {
    if (err.name !== "AbortError") toast("Sdílení se nepodařilo.");
  }
}

function downloadRec(rec) {
  const parts = recParts(rec);
  parts.forEach((p, i) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(p);
    a.download = fileNameFor(rec, i, parts.length);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
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

async function continueRecording(rec) {
  if (session) return toast("Už se nahrává.");
  closeDetail();
  window.scrollTo(0, 0);
  await startRecording(rec);
}

// ---------- události ----------

function bind() {
  $("#btnRecord").addEventListener("click", () => (session ? finishRecording(session, false) : startRecording()));
  $("#btnDark").addEventListener("click", () => ($("#dark").hidden = false));
  $("#dark").addEventListener("click", () => ($("#dark").hidden = true));
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

  $("#btnContinue").addEventListener("click", () => currentRec && continueRecording(currentRec));
  $("#btnFinish").addEventListener("click", () => currentRec && processRecording(currentRec));
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
  $("#btnDownload").addEventListener("click", () => currentRec && downloadRec(currentRec));
  $("#btnRedo").addEventListener("click", () => {
    const r = currentRec;
    if (!r) return;
    const notesOnly = r.status === "error" && !!r.transcript && !r.notes;
    processRecording(r, notesOnly ? { notesOnly: true } : { redo: true });
  });
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
  // Nahrávání ukončené zavřením aplikace obnovíme z uložených kousků;
  // rozpracované zpracování dokončíme.
  let recovered = null;
  for (const rec of await allRecs()) {
    if (rec.status === "recording") {
      await recoverRecording(rec);
      if (rec.status === "interrupted") recovered = rec;
    } else if (rec.status === "processing") {
      if (recParts(rec).length) processRecording(rec);
      else await putRec({ ...rec, status: "error", error: "Zvuk se neuložil." });
    }
  }
  await renderList();
  if (recovered) {
    openDetail(recovered.id);
    toast("Nahrávání se přerušilo. Zvuk je uložený – můžete pokračovat.");
  } else if (missingKeys()) {
    toast("Nejdřív v Nastavení (⚙︎) vložte API klíče.");
  }
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}

init();
