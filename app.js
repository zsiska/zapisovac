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
  defaultStyle: "standard",
  outLength: "normal",
  outLang: "cs",
  outAnon: "no",
  glossary: "",
  customStyle: "",
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

// Přepis se při chybě sítě nebo useknutém odeslání zkusí znovu.
const UPLOAD_RETRIES = [2, 6]; // sekundy čekání před 2. a 3. pokusem

// Soubor z úložiště telefonu nejdřív celý načteme do paměti. Safari jinak
// občas odešle zvuk uložený v IndexedDB useknutý („multipart: EOF“).
async function inMemory(blob) {
  try {
    const bytes = await blob.arrayBuffer();
    if (!bytes.byteLength) throw new Error("empty");
    return new Blob([bytes], { type: blob.type || "audio/mp4" });
  } catch {
    throw new Error("Zvuk se nepodařilo načíst z paměti telefonu. Zkuste aplikaci zavřít a otevřít, případně zvuk stáhnout a importovat znovu.");
  }
}

async function postForm(url, headers, makeForm, service) {
  for (let attempt = 0; ; attempt++) {
    let res;
    let failed = "";
    try {
      res = await fetch(url, { method: "POST", headers, body: makeForm() });
    } catch {
      failed = "network";
    }
    if (res) {
      if (res.status === 401) throw new Error(`Přepis selhal: neplatný ${service} klíč – opravte ho v Nastavení.`);
      if (res.status === 429) throw new Error(`Přepis selhal: vyčerpaný limit ${service}, zkuste to později.`);
      if (res.status === 413) throw new Error("Přepis selhal: nahrávka je pro službu příliš velká.");
      if (res.ok) return res.json();
      const text = await res.text();
      // Useknuté odeslání (slabý signál) nebo dočasná chyba serveru – zkusit znovu.
      if (/multipart|EOF|unexpected end/i.test(text) || res.status >= 500) failed = "upload";
      else throw new Error(`Přepis selhal (${res.status}): ${text.slice(0, 200)}`);
    }
    if (attempt >= UPLOAD_RETRIES.length) {
      throw new Error(failed === "network"
        ? "Přepis selhal: nepodařilo se spojit se serverem. Zkontrolujte připojení a klepněte na Zpracovat znovu."
        : "Přepis selhal: nahrávka se neodeslala celá (nejspíš slabý signál). Zkuste to na Wi-Fi tlačítkem Zpracovat znovu.");
    }
    await sleep(UPLOAD_RETRIES[attempt]);
  }
}

// Whisper si v tichu občas „vymyslí“ titulky – takové úseky zahodíme.
const HALLUCINATION = /titulky|subtitles|www\.|děkuji za pozornost|ďakujem za pozornosť/i;

// Jazyk se nezadává, aby šla čeština i slovenština; nápověda ho jen naznačí.
async function transcribeGroq(blob, st) {
  if (!st.groqKey) throw new Error("Chybí Groq API klíč – doplňte ho v Nastavení.");
  const audio = await inMemory(blob);
  const makeForm = () => {
    const fd = new FormData();
    fd.append("file", audio, "audio." + extFor(audio.type));
    fd.append("model", GROQ_MODEL);
    fd.append("response_format", "verbose_json");
    fd.append("temperature", "0");
    fd.append("prompt", "Pracovní schůzka v češtině, případně ve slovenčine.");
    return fd;
  };
  const data = await postForm(GROQ_URL, { Authorization: `Bearer ${st.groqKey}` }, makeForm, "Groq");
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
  const audio = await inMemory(blob);
  const makeForm = () => {
    const fd = new FormData();
    fd.append("file", audio, "audio." + extFor(audio.type));
    fd.append("model_id", ELEVEN_MODEL);
    fd.append("tag_audio_events", "false");
    if (diarize) fd.append("diarize", "true");
    return fd;
  };
  const data = await postForm(ELEVEN_URL, { "xi-api-key": st.elevenKey }, makeForm, "ElevenLabs");
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

// ---------- styly výstupu ----------

const STYLES = {
  standard: {
    label: "Podrobný zápis",
    desc: "Kompletní zápis: témata, rozhodnutí, úkoly, čísla.",
    prompt: `Vytvoř podrobný zápis. Struktura:
ZÁPIS ZE SCHŮZKY
Datum a čas, místo, délka (z údajů níže)

ÚČASTNÍCI – jména nebo role, pokud v přepisu zazní; jinak „neuvedeno“
SHRNUTÍ – 3 až 6 vět o tom, o čem schůzka byla a k čemu se došlo
PROJEDNANÁ TÉMATA – podrobně, každé téma s jeho podstatnými body
ROZHODNUTÍ
ÚKOLY – kdo, co, do kdy (pokud zazní)
TERMÍNY, ČÍSLA A ČÁSTKY – vše konkrétní, co zaznělo
OTEVŘENÉ OTÁZKY

Pokud jde o krátkou poznámku nebo hovor, přizpůsob rozsah.`,
  },
  formal: {
    label: "Formální protokol",
    desc: "Úřední jazyk, číslované body, usnesení. Pro instituce a soudy.",
    prompt: `Vytvoř formální protokol z jednání v úředním stylu: věcně, ve třetí osobě, bez hodnocení a citově zabarvených výrazů, s číslovanými body.
Struktura:
PROTOKOL Z JEDNÁNÍ
Datum, čas, místo a délka jednání
PŘÍTOMNI
PROGRAM JEDNÁNÍ – číslovaně
PRŮBĚH JEDNÁNÍ – ke každému bodu programu: co bylo projednáno a stanoviska účastníků
USNESENÍ A ZÁVĚRY – číslovaně, formulace typu „Bylo dohodnuto, že…“, „Účastníci se shodli, že…“
ULOŽENÉ ÚKOLY – odpovědná osoba, úkol, termín
Na konec: „Zapsáno automaticky aplikací Zapisovač. Ověřil: ____________“`,
  },
  exec: {
    label: "Manažerské shrnutí",
    desc: "Na jednu obrazovku: výsledek, rozhodnutí, rizika, další kroky.",
    prompt: `Vytvoř manažerské shrnutí, které se dá přečíst za 30 sekund. Nejvýše 12 řádků.
Struktura:
VÝSLEDEK – jedna věta
KLÍČOVÁ ROZHODNUTÍ – nejvýše 3 odrážky
RIZIKA A BLOKERY – nejvýše 3 odrážky
DALŠÍ KROKY – kdo, co, do kdy
Vynech vše, co nemá dopad na rozhodování.`,
  },
  tech: {
    label: "Technický zápis",
    desc: "Požadavky s ID, technická rozhodnutí, závislosti, otevřené otázky.",
    prompt: `Vytvoř technický zápis pro vývojáře a analytiky. Názvy systémů, modulů, rozhraní a odborné termíny zachovej přesně.
Struktura:
TECHNICKÝ ZÁPIS – téma
KONTEXT – 2 až 3 věty: jaký problém se řeší
POŽADAVKY – číslovaně R1, R2…; u každého popis, priorita (vysoká / střední / nízká) a kdo ho vznesl
TECHNICKÁ ROZHODNUTÍ – co se zvolilo a proč; zamítnuté varianty
ZÁVISLOSTI A INTEGRACE – systémy, rozhraní, data
RIZIKA
OTEVŘENÉ TECHNICKÉ OTÁZKY – číslovaně Q1, Q2…; u každé, kdo ji má zodpovědět
ÚKOLY – kdo, co, do kdy`,
  },
  tasks: {
    label: "Jen úkoly",
    desc: "Kdo, co, do kdy a s jakou prioritou. Nic navíc.",
    prompt: `Vypiš pouze úkoly, které ze schůzky vyplývají – výslovně zadané i jasně vyplývající ze slibů („pošlu“, „připravím“, „ozvu se“). Každý úkol na jeden řádek:
- [Kdo] Co přesně udělat – termín – priorita
Seřaď podle termínu. Na konci zvlášť uveď ÚKOLY BEZ ODPOVĚDNÉ OSOBY a ÚKOLY BEZ TERMÍNU, pokud nějaké jsou.`,
  },
  email: {
    label: "E-mail účastníkům",
    desc: "Hotový e-mail k odeslání: shrnutí, dohody, úkoly.",
    prompt: `Napiš hotový e-mail, který se po schůzce pošle všem účastníkům. První řádek: „Předmět: …“. Pak oslovení, jedna věta poděkování za účast, krátké shrnutí, odrážky s dohodami, úkoly (kdo – co – do kdy) a prosba o doplnění, pokud to někdo vidí jinak. Zakonči „S pozdravem“ a prázdným řádkem pro podpis. Tón profesionální a přátelský.`,
  },
  client: {
    label: "Pro klienta",
    desc: "Diplomaticky, bez interních poznámek. Co jsme dohodli a co dodáme.",
    prompt: `Vytvoř zápis určený klientovi. Vynech interní poznámky, spekulace, interní ceny a kritiku třetích stran. Formuluj diplomaticky a vstřícně, ale z dohod nic nezamlčuj.
Struktura:
SHRNUTÍ JEDNÁNÍ
CO JSME SPOLEČNĚ DOHODLI
CO DODÁME MY – co a do kdy
CO POTŘEBUJEME OD VÁS – co a do kdy
DALŠÍ KROK`,
  },
  friendly: {
    label: "S nadhledem",
    desc: "Lehký, vtipný tón pro tým. Fakta zůstávají přesná.",
    prompt: `Napiš zápis s nadhledem a lehkým humorem pro interní tým – jako když kolega s dobrým smyslem pro humor shrnuje poradu do týmového chatu. Krátké odstavce, vtipné mezititulky, střídmě emoji (nejvýše 5). Fakta, rozhodnutí, úkoly a termíny musí být přesné a úplné. Nezesměšňuj konkrétní lidi.`,
  },
  custom: {
    label: "Vlastní styl",
    desc: "Podle vašeho popisu v Nastavení.",
    prompt: "",
  },
};

const LENGTHS = {
  short: "Piš co nejstručněji – jen to podstatné.",
  normal: "",
  long: "Piš podrobně, zachyť i vedlejší body a argumenty jednotlivých stran.",
};
const LANGS = { cs: "česky", sk: "slovensky", en: "anglicky (in English)", de: "německy (auf Deutsch)" };

const INTRO = "Jsi pečlivý zapisovatel porad. Dostaneš automatický přepis řeči ze schůzky nebo telefonního hovoru, v češtině nebo slovenštině (i střídavě). Přepis může obsahovat chyby rozpoznávání; mluvčí mohou být označeni „Mluvčí 1“, „Mluvčí 2“ atd. – pokud z obsahu vyplyne jejich jméno nebo role, použij ho.";

function glossaryRule() {
  const g = (loadSettings().glossary || "").trim();
  return g ? `\nOdborné termíny, názvy a jména piš přesně podle tohoto slovníku – v přepisu mohou být zkomolené:\n${g}` : "";
}

function outputRules(opts) {
  const rules = [
    `Výstup piš ${LANGS[opts.lang] || "česky"}.`,
    "Piš prostý text bez Markdownu (žádné #, ** ani tabulky); nadpisy VELKÝMI PÍSMENY, odrážky pomlčkou. Text se vkládá přímo do e-mailu.",
    "Nevymýšlej nic, co v přepisu není; nejasná místa označ [nejasné]. Sekce, ke kterým přepis nic neobsahuje, vynech.",
  ];
  if (LENGTHS[opts.length]) rules.push(LENGTHS[opts.length]);
  if (opts.anon === "yes") {
    rules.push("Anonymizuj osoby: jména nahraď rolemi (např. „vedoucí projektu“, „zástupce klienta“, „Účastník A“). Vynech telefonní čísla, e-maily, adresy a rodná čísla.");
  }
  if (opts.extra?.trim()) rules.push(`Doplňující pokyn uživatele: ${opts.extra.trim()}`);
  return rules.join("\n") + glossaryRule();
}

function styleSystem(opts) {
  const custom = (loadSettings().customStyle || "").trim();
  const body = opts.style === "custom" ? custom || STYLES.standard.prompt : (STYLES[opts.style] || STYLES.standard).prompt;
  return `${INTRO}\n\n${body}\n\nPravidla:\n${outputRules(opts)}`;
}

function defaultOpts() {
  const st = loadSettings();
  return { style: st.defaultStyle, length: st.outLength, lang: st.outLang, anon: st.outAnon, extra: "" };
}

function notesInput(rec) {
  const info = [
    `Datum a čas: ${new Date(rec.created).toLocaleString("cs-CZ")}`,
    `Místo: ${rec.place || "neuvedeno"}`,
    `Délka: ${rec.duration ? clock(rec.duration) : "neuvedeno"}`,
  ].join("\n");
  return `${info}\n\n<prepis>\n${rec.transcript}\n</prepis>`;
}

// ---------- volání AI (Gemini / Claude) ----------

const GEMINI_FALLBACK = "gemini-flash-latest";
const RETRY_DELAYS = [3, 8, 15]; // sekundy mezi pokusy při přetížení

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

function geminiRequest(st, model, body) {
  return fetch(`${GEMINI_URL}/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
    method: "POST",
    headers: { "x-goog-api-key": st.geminiKey, "Content-Type": "application/json" },
    body,
  });
}

// Přetížení (503) nebo dočasná chyba serveru: zkusit znovu s prodlevou,
// nakonec jednou záložní model.
async function geminiWithRetry(st, model, body, say) {
  const busy = (code) => code >= 500 && code <= 504;
  let res;
  for (let i = 0; ; i++) {
    try {
      res = await geminiRequest(st, model, body);
    } catch {
      throw new Error("Nejste připojeni k internetu.");
    }
    if (!busy(res.status) || i >= RETRY_DELAYS.length) break;
    say(`Gemini je přetížený, zkouším znovu za ${RETRY_DELAYS[i]} s (pokus ${i + 2}/${RETRY_DELAYS.length + 1})…`);
    await sleep(RETRY_DELAYS[i]);
    say("");
  }
  if (busy(res.status) && model !== GEMINI_FALLBACK) {
    say("Gemini je přetížený, zkouším záložní model…");
    try {
      const alt = await geminiRequest(st, GEMINI_FALLBACK, body);
      if (alt.ok) {
        say("");
        return alt;
      }
    } catch {}
  }
  return res;
}

async function llmGemini({ system, input, onText, say, json }) {
  const st = loadSettings();
  if (!st.geminiKey) throw new Error("Chybí Gemini API klíč – doplňte ho v Nastavení.");
  const model = st.geminiModel || DEFAULTS.geminiModel;
  const generationConfig = { maxOutputTokens: 32768 };
  if (json) generationConfig.responseMimeType = "application/json";
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: input }] }],
    generationConfig,
  });
  const res = await geminiWithRetry(st, model, body, say);
  if (!res.ok) {
    const text = await res.text();
    if (/API_KEY_INVALID|API key not valid/.test(text)) throw new Error("Neplatný Gemini klíč – opravte ho v Nastavení.");
    if (res.status === 429) throw new Error("Vyčerpaný bezplatný limit Gemini. Zkuste to později.");
    if (res.status === 404) throw new Error(`Model „${model}“ neexistuje – změňte ho v Nastavení.`);
    if (res.status >= 500) throw new Error("Gemini je teď přetížený. Přepis je uložený – zkuste to za pár minut znovu, nebo v Nastavení přepněte na Aplikaci Claude.");
    throw new Error(`Gemini vrátil chybu ${res.status}: ${text.slice(0, 200)}`);
  }
  // Odpověď chodí jako SSE: řádky „data: {json}“.
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  let out = "";
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
          out += p.text;
          onText(out);
        }
      }
      if (cand?.finishReason) finish = cand.finishReason;
    }
  }
  if (!out) {
    throw new Error(/SAFETY|PROHIBITED/.test(finish) ? "Gemini odmítl tento přepis zpracovat." : "Gemini nevrátil žádný text.");
  }
  return out.trim();
}

async function llmClaude({ system, input, onText }) {
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
      system,
      messages: [{ role: "user", content: input }],
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
    if (err instanceof Anthropic.AuthenticationError) throw new Error("Neplatný Anthropic klíč – opravte ho v Nastavení.");
    if (err instanceof Anthropic.RateLimitError) throw new Error("Příliš mnoho požadavků na Claude, zkuste to za chvíli.");
    if (err instanceof Anthropic.APIConnectionError) throw new Error("Nejste připojeni k internetu.");
    if (err instanceof Anthropic.APIError) throw new Error(`Claude vrátil chybu ${err.status}: ${err.message}`);
    throw err;
  }
}

// Ruční režim: zadání se zkopíruje a otevře se aplikace, kterou si uživatel
// platí (Claude, ChatGPT); hotovou odpověď pak vloží zpět ze schránky.
const MANUAL_APPS = {
  "claude-manual": { name: "Claude", url: "https://claude.ai/new" },
  "chatgpt-manual": { name: "ChatGPT", url: "https://chatgpt.com/" },
};

function manualApp(st = loadSettings()) {
  return MANUAL_APPS[st.notesProvider] || null;
}

// Automatická AI přes API klíč; v ručním režimu null.
function aiProvider(st = loadSettings()) {
  if (st.notesProvider === "anthropic") return st.anthropicKey ? "anthropic" : null;
  if (st.notesProvider === "gemini") return st.geminiKey ? "gemini" : null;
  return null;
}

// Má se úloha poslat ručně do aplikace? (ruční režim, nebo chybí klíč)
function goManual() {
  return !aiProvider() && !!manualApp();
}

function copyText(text, okMsg) {
  navigator.clipboard.writeText(text).then(
    () => okMsg && toast(okMsg),
    () => toast("Kopírování se nepodařilo."),
  );
}

// job: { kind: "version" | "tasks" | "ask", prompt, label, opts? }
// Musí běžet hned v rámci klepnutí (schránka a otevření okna).
function manualRun(rec, job) {
  const app = manualApp() || MANUAL_APPS["claude-manual"];
  const prompt = `${job.prompt}\n\nOdpověz pouze samotným výsledkem, bez úvodu a závěrečných komentářů.`;
  copyText(prompt, `Zadání zkopírováno. V aplikaci ${app.name} ho vložte do nové konverzace.`);
  window.open(app.url, "_blank");
  rec.pendingManual = { ...job, prompt, app: app.name, at: new Date().toISOString() };
  putRec(rec).catch(() => {});
  refresh(rec);
}

async function pasteManual(rec) {
  const job = rec.pendingManual || { kind: "version", label: versionLabel(defaultOpts()), opts: defaultOpts(), app: (manualApp() || MANUAL_APPS["claude-manual"]).name };
  let text = "";
  try {
    text = (await navigator.clipboard.readText()).trim();
  } catch {
    return toast("Schránku se nepodařilo přečíst. Povolte vložení a zkuste to znovu.");
  }
  if (!text || text.includes("<prepis>")) return toast(`Ve schránce není odpověď. V aplikaci ${job.app} ji nejdřív zkopírujte.`);
  try {
    if (job.kind === "tasks") {
      setTasks(rec, parseJsonArray(text));
      showTab("tasks");
    } else if (job.kind === "ask") {
      rec.qa = rec.qa || [];
      rec.qa.unshift({ q: job.label, a: text, at: new Date().toISOString() });
      showTab("ask");
    } else {
      addVersion(rec, job.opts || { style: "standard" }, text, job.label);
      showTab("notes");
    }
  } catch (err) {
    return toast(err.message || String(err));
  }
  delete rec.pendingManual;
  if (["manual", "error"].includes(rec.status)) Object.assign(rec, { status: "done", error: "" });
  await putRec(rec);
  refresh(rec);
  toast(job.kind === "tasks" ? `Vloženo úkolů: ${rec.tasks.length}` : job.kind === "ask" ? "Odpověď vložena." : "Vloženo jako nová verze.");
}

function llm({ system, input, onText = () => {}, say = () => {}, json = false }) {
  const p = aiProvider();
  if (!p) throw new Error("Chybí API klíč pro zvolenou AI – doplňte ho v Nastavení, nebo tam zvolte ruční režim přes Claude či ChatGPT.");
  return p === "anthropic" ? llmClaude({ system, input, onText }) : llmGemini({ system, input, onText, say, json });
}

// ---------- verze výstupu ----------

const rid = () => crypto.randomUUID().slice(0, 8);

// Starší nahrávky mají jen rec.notes – převedeme na první verzi.
function versionsOf(rec) {
  if (!rec.versions) {
    rec.versions = rec.notes
      ? [{ id: "v0", style: "standard", opts: { style: "standard" }, label: STYLES.standard.label, text: rec.notes, created: rec.created }]
      : [];
    rec.active = rec.versions[0]?.id || null;
  }
  return rec.versions;
}

function activeVersion(rec) {
  const vs = versionsOf(rec);
  return vs.find((v) => v.id === rec.active) || vs[vs.length - 1] || null;
}

function setActive(rec, id) {
  rec.active = id;
  rec.notes = activeVersion(rec)?.text || "";
}

function versionLabel(o) {
  let l = (STYLES[o.style] || STYLES.standard).label;
  if (o.lang && o.lang !== "cs") l += ` · ${o.lang.toUpperCase()}`;
  if (o.length === "short") l += " · stručně";
  if (o.length === "long") l += " · podrobně";
  if (o.anon === "yes") l += " · anonymní";
  return l;
}

function addVersion(rec, opts, text, label) {
  versionsOf(rec);
  const v = { id: rid(), style: opts.style, opts, label: label || versionLabel(opts), text, created: new Date().toISOString() };
  rec.versions.push(v);
  setActive(rec, v.id);
  return v;
}

// Rozpracovaná verze (streamuje se): rec.id -> { label, text, status }
const drafts = new Map();

async function generateVersion(rec, opts, { system, input, label } = {}) {
  if (drafts.has(rec.id) || processing.has(rec.id)) return toast("Počkejte, až se dokončí rozpracovaná verze.");
  if (!rec.transcript) return toast("Nejdřív je potřeba mít přepis.");
  if (goManual()) {
    return manualRun(rec, {
      kind: "version",
      prompt: `${system || styleSystem(opts)}\n\n${input || notesInput(rec)}`,
      label: label || versionLabel(opts),
      opts,
    });
  }
  const draft = { label: label || versionLabel(opts), text: "", status: "" };
  drafts.set(rec.id, draft);
  showTab("notes");
  refresh(rec);
  let last = 0;
  try {
    const text = await llm({
      system: system || styleSystem(opts),
      input: input || notesInput(rec),
      say: (t) => {
        draft.status = t;
        refresh(rec);
      },
      onText: (t) => {
        draft.text = t;
        if (Date.now() - last > 150) {
          last = Date.now();
          refresh(rec);
        }
      },
    });
    addVersion(rec, opts, text, draft.label);
    if (["error", "manual"].includes(rec.status)) Object.assign(rec, { status: "done", error: "" });
    await putRec(rec);
    toast("Nová verze je hotová.");
  } catch (err) {
    toast(err.message || String(err));
  } finally {
    drafts.delete(rec.id);
    refresh(rec);
  }
}

const EDIT_QUICK = [
  ["Zkrátit na polovinu", "Zkrať text zhruba na polovinu, zachovej všechna rozhodnutí, úkoly a termíny."],
  ["Formálněji", "Přepiš formálnějším, úředním jazykem."],
  ["Doplnit čísla a termíny", "Projdi přepis a doplň do zápisu všechna čísla, částky, data a termíny, které v něm chybí."],
  ["Jen odrážky", "Převeď celý text na stručné odrážky, žádné souvislé odstavce."],
  ["Do angličtiny", "Přelož celý text do angličtiny."],
  ["Do slovenštiny", "Prelož celý text do slovenčiny."],
];

function aiEdit(rec, instruction) {
  const v = activeVersion(rec);
  if (!v) return toast("Nejdřív je potřeba mít zápis.");
  const system = `Upravuješ hotový zápis ze schůzky podle pokynu uživatele. Přepis schůzky máš k dispozici pro kontrolu faktů – nepřidávej nic, co v něm není. Vrať celý upravený text (ne jen změny), bez úvodu a komentářů. Zachovej jazyk zápisu, pokud pokyn neříká jinak. Piš prostý text bez Markdownu (žádné #, ** ani tabulky).${glossaryRule()}`;
  const input = `<prepis>\n${rec.transcript}\n</prepis>\n\n<zapis>\n${v.text}\n</zapis>\n\nPokyn: ${instruction}`;
  const base = v.label.replace(/ · upraveno.*$/, "");
  return generateVersion(rec, { ...(v.opts || {}), style: v.style }, { system, input, label: `${base} · upraveno` });
}

// ---------- úkoly ----------

const ops = new Set(); // běžící akce: `${rec.id}:tasks`, `${rec.id}:ask`

function isoDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fmtDate(iso) {
  const d = new Date(`${iso}T12:00:00`);
  return d.toLocaleDateString("cs-CZ", { weekday: "short", day: "numeric", month: "numeric" });
}

function parseJsonArray(text) {
  const clean = text.replace(/```(?:json)?/g, "");
  const a = clean.indexOf("[");
  const b = clean.lastIndexOf("]");
  try {
    const arr = JSON.parse(clean.slice(a, b + 1));
    if (Array.isArray(arr)) return arr;
  } catch {}
  throw new Error("AI nevrátila platný seznam úkolů. Zkuste to znovu.");
}

function tasksSystem(rec) {
  const day = new Date(rec.created);
  return `Z přepisu schůzky vytáhni všechny úkoly – výslovně zadané i jasně vyplývající ze slibů („pošlu“, „připravím“, „ozvu se“, „zjistím“).
Schůzka proběhla ${day.toLocaleDateString("cs-CZ", { weekday: "long", day: "numeric", month: "long", year: "numeric" })} (${isoDate(day)}). Relativní termíny („do pátku“, „příští týden“, „do konce měsíce“) přepočítej na konkrétní datum.
Vrať POUZE JSON pole, nic jiného. Každý prvek:
{"co": "konkrétní úkol, začni slovesem", "kdo": "jméno nebo role, nebo null", "termin": "YYYY-MM-DD nebo null", "termin_text": "termín tak, jak zazněl, nebo null", "priorita": "vysoká" | "střední" | "nízká"}
Úkoly piš česky. Nevymýšlej úkoly, které z přepisu nevyplývají. Když žádné nejsou, vrať [].${glossaryRule()}`;
}

function setTasks(rec, arr) {
  const old = new Map((rec.tasks || []).map((t) => [t.what.toLowerCase(), t.done]));
  rec.tasks = arr
    .map((t) => ({
      id: rid(),
      what: String(t.co || t.what || "").trim(),
      who: t.kdo ? String(t.kdo) : "",
      due: /^\d{4}-\d{2}-\d{2}$/.test(t.termin || "") ? t.termin : "",
      dueText: t.termin_text ? String(t.termin_text) : "",
      prio: t.priorita || "střední",
      done: false,
    }))
    .filter((t) => t.what)
    .map((t) => ({ ...t, done: old.get(t.what.toLowerCase()) || false }))
    .sort((x, y) => (x.due || "9999").localeCompare(y.due || "9999"));
  rec.tasksAt = new Date().toISOString();
}

async function extractTasks(rec) {
  const key = `${rec.id}:tasks`;
  if (ops.has(key)) return;
  if (!rec.transcript) return toast("Nejdřív je potřeba mít přepis.");
  if (goManual()) {
    return manualRun(rec, { kind: "tasks", prompt: `${tasksSystem(rec)}\n\n${notesInput(rec)}`, label: "Úkoly ze schůzky" });
  }
  ops.add(key);
  refresh(rec);
  try {
    const text = await llm({ system: tasksSystem(rec), input: notesInput(rec), json: true });
    setTasks(rec, parseJsonArray(text));
    await putRec(rec);
    toast(rec.tasks.length ? `Nalezeno úkolů: ${rec.tasks.length}` : "Ve schůzce nezazněly žádné úkoly.");
  } catch (err) {
    toast(err.message || String(err));
  } finally {
    ops.delete(key);
    refresh(rec);
  }
}

function tasksText(rec) {
  return (rec.tasks || [])
    .map((t) => `${t.done ? "☑" : "☐"} ${t.who ? t.who + ": " : ""}${t.what}${t.due ? ` (do ${new Date(`${t.due}T12:00:00`).toLocaleDateString("cs-CZ")})` : t.dueText ? ` (${t.dueText})` : ""}`)
    .join("\n");
}

function icsEsc(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/([,;])/g, "\\$1");
}

function tasksIcs(rec) {
  const now = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Zapisovac//CS", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
  for (const t of (rec.tasks || []).filter((t) => t.due && !t.done)) {
    const start = t.due.replace(/-/g, "");
    const end = isoDate(new Date(new Date(`${t.due}T12:00:00`).getTime() + 864e5)).replace(/-/g, "");
    lines.push(
      "BEGIN:VEVENT",
      `UID:${rec.id}-${t.id}@zapisovac`,
      `DTSTAMP:${now}`,
      `DTSTART;VALUE=DATE:${start}`,
      `DTEND;VALUE=DATE:${end}`,
      `SUMMARY:${icsEsc((t.who ? t.who + ": " : "") + t.what)}`,
      `DESCRIPTION:${icsEsc(`Úkol ze schůzky ${rec.name}`)}`,
      "BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icsEsc(t.what)}`, "TRIGGER:-PT15H", "END:VALARM",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

// ---------- otázky ke schůzce ----------

const ASK_QUICK = [
  ["Co zůstalo nedořešené?", "Co zůstalo nedořešené? Vypiš otevřené body, úkoly bez odpovědné osoby nebo bez termínu a věci, které někdo zmínil, ale nikdo je nevzal na sebe."],
  ["Kdo co slíbil?", "Kdo co slíbil nebo na sebe vzal? U každého uveď krátkou doslovnou citaci z přepisu."],
  ["Ověřit zápis", "verify"],
  ["Čísla a termíny", "Vypiš všechna čísla, částky, data a termíny, které zazněly, a v jaké souvislosti."],
  ["Rizika a nesouhlas", "Jaká rizika, obavy nebo nesouhlasy na schůzce zazněly a od koho?"],
];

const VERIFY_Q = `Porovnej zápis s přepisem a napiš:
TVRZENÍ BEZ OPORY V PŘEPISU – co zápis tvrdí, ale přepis to neříká nebo to říká jinak (s citací)
CO V ZÁPISU CHYBÍ – důležité věci z přepisu, které zápis vynechal
VERDIKT – jedna věta, zda je zápis věrný`;

async function ask(rec, question, label) {
  const key = `${rec.id}:ask`;
  if (ops.has(key)) return;
  if (!rec.transcript) return toast("Nejdřív je potřeba mít přepis.");
  const verify = question === "verify";
  const v = activeVersion(rec);
  if (verify && !v) return toast("Není co ověřovat – zápis zatím není.");
  const system = `Odpovídáš na otázky k jedné konkrétní schůzce. Vycházej jen z přepisu${verify ? " a zápisu" : ""}. Tvrzení podlož krátkou doslovnou citací z přepisu v uvozovkách. Pokud odpověď v přepisu není, řekni to rovnou. Odpovídej stručně, česky, prostým textem bez Markdownu; nadpisy VELKÝMI PÍSMENY, odrážky pomlčkou.${glossaryRule()}`;
  const input = `${notesInput(rec)}${verify ? `\n\n<zapis>\n${v.text}\n</zapis>` : ""}\n\nOtázka: ${verify ? VERIFY_Q : question}`;
  if (goManual()) return manualRun(rec, { kind: "ask", prompt: `${system}\n\n${input}`, label: label || question });
  ops.add(key);
  rec.qa = rec.qa || [];
  const item = { q: label || question, a: "", at: new Date().toISOString(), pending: true };
  rec.qa.unshift(item);
  refresh(rec);
  let last = 0;
  try {
    item.a = await llm({
      system,
      input,
      onText: (t) => {
        item.a = t;
        if (Date.now() - last > 150) {
          last = Date.now();
          refresh(rec);
        }
      },
    });
  } catch (err) {
    item.a = `Nepodařilo se: ${err.message || err}`;
    item.error = true;
  } finally {
    delete item.pending;
    ops.delete(key);
    await putRec(rec);
    refresh(rec);
  }
}

// ---------- uložení souboru ----------

async function saveFile(name, text, type, { preferShare = true } = {}) {
  const file = new File([text], name, { type });
  if (preferShare && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (err) {
      if (err.name === "AbortError") return;
    }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function safeName(s) {
  return s.replace(/[\\/:*?"<>|]/g, "-");
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
    if (manualApp(st)) {
      await update({ status: "manual", progress: "" });
      return;
    }
    await update({ progress: "Píšu zápis ze schůzky…" });
    const opts = defaultOpts();
    const draft = { label: versionLabel(opts), text: "", status: "" };
    drafts.set(rec.id, draft);
    let last = 0;
    try {
      const notes = await llm({
        system: styleSystem(opts),
        input: notesInput(rec),
        say: (t) => {
          rec.progress = t || "Píšu zápis ze schůzky…";
          refresh(rec);
        },
        onText: (t) => {
          draft.text = t;
          if (Date.now() - last > 150) {
            last = Date.now();
            refresh(rec);
          }
        },
      });
      addVersion(rec, opts, notes);
    } catch (err) {
      throw new Error(`Zápis se nepodařil: ${err.message || err}`);
    } finally {
      drafts.delete(rec.id);
    }
    await update({ status: "done", progress: "" });
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
  stopEditing();
  $("#aiEditBox").hidden = true;
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
  interrupted: "Nahrávání se přerušilo (zamčení telefonu nebo hovor). Zvuk do té chvíle je uložený. Můžete pokračovat ve stejné nahrávce, nebo ji dokončit a zpracovat.",
};

function renderDetail(rec) {
  currentRec = rec;
  $("#dTitle").textContent = rec.name;
  const created = new Date(rec.created);
  $("#dMeta").textContent = [created.toLocaleString("cs-CZ"), rec.place, rec.duration ? clock(rec.duration) : ""].filter(Boolean).join(" · ");
  const status = $("#dStatus");
  status.hidden = !["processing", "error", "interrupted"].includes(rec.status);
  status.classList.toggle("error", rec.status === "error");
  status.textContent = rec.status === "error" ? rec.error : STATUS_TEXT[rec.status] || rec.progress || "Zpracovávám…";
  const busy = processing.has(rec.id);
  const canContinue = rec.source === "mic" && !busy && !session && rec.status !== "processing";
  $("#resumeBox").hidden = !canContinue;
  $("#btnFinish").hidden = rec.status !== "interrupted";
  $("#btnContinue").classList.toggle("secondary", rec.status !== "interrupted");
  renderManual(rec);
  renderNotes(rec);
  renderTasks(rec);
  renderQa(rec);
  $("#dTranscript").textContent = rec.transcript || rec.live || "Přepis zatím není.";
  $("#btnRedo").disabled = busy || rec.status === "interrupted";
  $("#btnEmail").disabled = !rec.notes || busy;
  $("#btnCopy").disabled = !rec.notes;
}

function refresh(rec) {
  if (currentId === rec.id) renderDetail(rec);
  else renderList();
}

const PANELS = { notes: "#pNotes", tasks: "#pTasks", ask: "#pAsk", transcript: "#dTranscript" };

function showTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  for (const [k, sel] of Object.entries(PANELS)) $(sel).hidden = k !== name;
}

function renderNotes(rec) {
  const vs = versionsOf(rec);
  const draft = drafts.get(rec.id);
  const act = activeVersion(rec);
  $("#dVersions").innerHTML =
    vs.map((v) => `<button class="vchip${!draft && v.id === act?.id ? " active" : ""}" data-vid="${v.id}">${esc(v.label)}</button>`).join("") +
    (draft ? `<span class="vchip active drafting"><i class="spin"></i>${esc(draft.label)}</span>` : "") +
    `<button class="vchip add" data-new="1"><svg><use href="#i-plus"/></svg>Nový styl</button>`;
  if (draft) $("#dVersions").lastElementChild.previousElementSibling?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  const editing = !$("#dNotesEdit").hidden;
  if (!editing) {
    $("#dNotes").textContent = draft
      ? draft.text || draft.status || "Píšu novou verzi…"
      : act ? act.text : rec.status === "processing" ? "Zápis se připravuje…" : "Zápis zatím není.";
  }
  $("#dNotes").classList.toggle("streaming", !!draft);
  $("#notesTools").hidden = !act || !!draft || editing;
  $("#btnDelVersion").hidden = vs.length < 2;
  $("#aiEditGo").disabled = !!draft;
}

function renderTasks(rec) {
  const busy = ops.has(`${rec.id}:tasks`);
  const tasks = rec.tasks || [];
  const btn = $("#btnTasks");
  btn.disabled = busy || !rec.transcript;
  const via = goManual() ? ` v ${manualApp().name}` : "";
  btn.innerHTML = busy ? `<i class="spin"></i>Hledám úkoly…` : `<svg><use href="#i-sparkle"/></svg>${tasks.length ? "Najít znovu" : "Najít úkoly"}${via}`;
  $("#tasksActions").hidden = !tasks.length;
  $("#btnTasksIcs").disabled = !tasks.some((t) => t.due && !t.done);
  const done = tasks.filter((t) => t.done).length;
  $("#tasksSummary").textContent = tasks.length ? `${done} z ${tasks.length} hotovo` : "";
  $("#dTasks").innerHTML = tasks.length
    ? tasks.map((t) => `
      <li class="task${t.done ? " done" : ""}">
        <label>
          <input type="checkbox" data-tid="${t.id}"${t.done ? " checked" : ""}>
          <span class="tick"><svg><use href="#i-check"/></svg></span>
          <span class="task-body">
            <span class="task-what">${esc(t.what)}</span>
            <span class="task-meta">
              ${t.who ? `<span class="chip">${esc(t.who)}</span>` : `<span class="chip s-interrupted">kdo?</span>`}
              ${t.due ? `<span class="chip s-processing">${esc(fmtDate(t.due))}</span>` : t.dueText ? `<span class="chip">${esc(t.dueText)}</span>` : `<span class="chip">bez termínu</span>`}
              ${t.prio === "vysoká" ? `<span class="chip s-error">priorita</span>` : ""}
            </span>
          </span>
        </label>
      </li>`).join("")
    : `<li class="panel-empty">${busy ? "Procházím přepis…" : "AI projde přepis a sestaví seznam: kdo co slíbil a do kdy. Úkoly pak můžete odškrtávat, poslat e-mailem nebo přidat do kalendáře."}</li>`;
}

function renderQa(rec) {
  const busy = ops.has(`${rec.id}:ask`);
  $("#askGo").disabled = busy || !rec.transcript;
  document.querySelectorAll("#askQuick button").forEach((b) => (b.disabled = busy || !rec.transcript));
  const qa = rec.qa || [];
  $("#dQa").innerHTML = qa.length
    ? qa.map((x) => `
      <div class="qa-item${x.error ? " error" : ""}">
        <div class="qa-q">${esc(x.q)}</div>
        <div class="qa-a">${x.pending && !x.a ? `<i class="spin"></i>Hledám v přepisu…` : esc(x.a)}</div>
      </div>`).join("")
    : `<p class="panel-empty">Zeptejte se na cokoli, co na schůzce zaznělo. Odpovědi jsou podložené citacemi z přepisu.</p>`;
}

function stopEditing() {
  $("#dNotesEdit").hidden = true;
  $("#editBar").hidden = true;
  $("#dNotes").hidden = false;
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

function renderManual(rec) {
  const pend = rec.pendingManual;
  const app = manualApp() || MANUAL_APPS["claude-manual"];
  $("#manualBox").hidden = !rec.transcript || (!pend && rec.status !== "manual");
  $("#btnManualCancel").hidden = !pend;
  if (pend) {
    $("#manualText").textContent = `Čeká se na odpověď z aplikace ${pend.app}: ${pend.label}. Zadání je ve schránce – vložte ho do nové konverzace, odpověď zkopírujte a klepněte na Vložit.`;
    $("#btnClaudeLabel").textContent = `Znovu zkopírovat a otevřít ${pend.app}`;
    $("#btnPasteLabel").textContent = "Vložit odpověď ze schránky";
  } else {
    $("#manualText").textContent = `Přepis je hotový. Klepněte na 1. – zadání se zkopíruje a otevře se ${app.name}. Tam ho vložte, hotový zápis zkopírujte a klepněte na 2.`;
    $("#btnClaudeLabel").textContent = `1. Napsat zápis v aplikaci ${app.name}`;
    $("#btnPasteLabel").textContent = "2. Vložit hotový zápis ze schránky";
  }
}

function manualStart(rec) {
  const pend = rec.pendingManual;
  if (pend) {
    copyText(pend.prompt, `Zadání zkopírováno. Vložte ho v aplikaci ${pend.app}.`);
    const url = Object.values(MANUAL_APPS).find((a) => a.name === pend.app)?.url || MANUAL_APPS["claude-manual"].url;
    window.open(url, "_blank");
    return;
  }
  const opts = defaultOpts();
  manualRun(rec, { kind: "version", prompt: `${styleSystem(opts)}\n\n${notesInput(rec)}`, label: versionLabel(opts), opts });
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
  $("#btnClaude").addEventListener("click", () => currentRec && manualStart(currentRec));
  $("#btnPaste").addEventListener("click", () => currentRec && pasteManual(currentRec));
  $("#btnManualCancel").addEventListener("click", async () => {
    const rec = currentRec;
    if (!rec) return;
    delete rec.pendingManual;
    await putRec(rec);
    refresh(rec);
  });
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

  // --- verze výstupu ---
  $("#dVersions").addEventListener("click", async (e) => {
    const rec = currentRec;
    if (!rec) return;
    if (e.target.closest("[data-new]")) return openStyleDialog();
    const b = e.target.closest("[data-vid]");
    if (!b || drafts.has(rec.id)) return;
    stopEditing();
    setActive(rec, b.dataset.vid);
    await putRec(rec);
    refresh(rec);
  });
  $("#btnEditText").addEventListener("click", () => {
    const v = currentRec && activeVersion(currentRec);
    if (!v) return;
    $("#dNotesEdit").value = v.text;
    $("#dNotesEdit").hidden = false;
    $("#editBar").hidden = false;
    $("#dNotes").hidden = true;
    $("#aiEditBox").hidden = true;
    $("#notesTools").hidden = true;
    $("#dNotesEdit").focus();
  });
  $("#btnEditCancel").addEventListener("click", () => {
    stopEditing();
    refresh(currentRec);
  });
  $("#btnEditSave").addEventListener("click", async () => {
    const rec = currentRec;
    const v = rec && activeVersion(rec);
    if (!v) return;
    v.text = $("#dNotesEdit").value.trim();
    v.edited = true;
    rec.notes = v.text;
    await putRec(rec);
    stopEditing();
    refresh(rec);
    toast("Úpravy uloženy.");
  });
  $("#btnAiEdit").addEventListener("click", () => {
    const box = $("#aiEditBox");
    box.hidden = !box.hidden;
    if (!box.hidden) $("#aiEditInput").focus();
  });
  $("#aiEditQuick").innerHTML = EDIT_QUICK.map(([l], i) => `<button type="button" class="qchip" data-i="${i}">${esc(l)}</button>`).join("");
  $("#aiEditQuick").addEventListener("click", (e) => {
    const b = e.target.closest("[data-i]");
    if (!b || !currentRec) return;
    $("#aiEditBox").hidden = true;
    aiEdit(currentRec, EDIT_QUICK[b.dataset.i][1]);
  });
  const runAiEdit = () => {
    const q = $("#aiEditInput").value.trim();
    if (!q || !currentRec) return;
    $("#aiEditInput").value = "";
    $("#aiEditBox").hidden = true;
    aiEdit(currentRec, q);
  };
  $("#aiEditGo").addEventListener("click", runAiEdit);
  $("#aiEditInput").addEventListener("keydown", (e) => e.key === "Enter" && runAiEdit());
  $("#btnSaveFile").addEventListener("click", () => {
    const rec = currentRec;
    const v = rec && activeVersion(rec);
    if (v) saveFile(`${safeName(rec.name)} – ${safeName(v.label)}.txt`, v.text, "text/plain");
  });
  $("#btnDelVersion").addEventListener("click", async () => {
    const rec = currentRec;
    const v = rec && activeVersion(rec);
    if (!v || rec.versions.length < 2) return;
    if (!confirm(`Smazat verzi „${v.label}“?`)) return;
    rec.versions = rec.versions.filter((x) => x.id !== v.id);
    setActive(rec, rec.versions[rec.versions.length - 1].id);
    await putRec(rec);
    refresh(rec);
  });

  // --- nový styl ---
  const sdlg = $("#styleDlg");
  const sform = $("#styleForm");
  $("#styleGrid").innerHTML = Object.entries(STYLES).map(([id, s]) => `
    <label class="style-card">
      <input type="radio" name="style" value="${id}">
      <span class="sc-title">${esc(s.label)}</span>
      <span class="sc-desc">${esc(s.desc)}</span>
    </label>`).join("");
  function openStyleDialog() {
    if (!currentRec?.transcript) return toast("Nejdřív je potřeba mít přepis.");
    const o = defaultOpts();
    sform.elements.style.value = o.style;
    sform.elements.slength.value = o.length;
    sform.elements.slang.value = o.lang;
    sform.elements.sanon.value = o.anon;
    sform.elements.sextra.value = "";
    const app = goManual() && manualApp();
    $("#styleManualNote").hidden = !app;
    if (app) $("#styleManualNote").textContent = `Zadání se zkopíruje a otevře se aplikace ${app.name}. Hotový text tam zkopírujte a tady klepněte na „Vložit odpověď ze schránky“.`;
    sdlg.showModal();
  }
  // Vytvoření běží přímo v klepnutí – v ručním režimu se kopíruje do schránky
  // a otevírá aplikace, což Safari dovolí jen během klepnutí.
  sform.querySelector('button[value="create"]').addEventListener("click", (e) => {
    e.preventDefault();
    if (!currentRec) return sdlg.close();
    const opts = {
      style: sform.elements.style.value || "standard",
      length: sform.elements.slength.value,
      lang: sform.elements.slang.value,
      anon: sform.elements.sanon.value,
      extra: sform.elements.sextra.value,
    };
    sdlg.close();
    generateVersion(currentRec, opts);
  });

  // --- úkoly ---
  $("#btnTasks").addEventListener("click", () => currentRec && extractTasks(currentRec));
  $("#dTasks").addEventListener("change", async (e) => {
    const id = e.target.dataset.tid;
    const rec = currentRec;
    const t = rec?.tasks?.find((x) => x.id === id);
    if (!t) return;
    t.done = e.target.checked;
    await putRec(rec);
    refresh(rec);
  });
  $("#btnTasksCopy").addEventListener("click", () => {
    navigator.clipboard.writeText(tasksText(currentRec)).then(
      () => toast("Úkoly zkopírovány."),
      () => toast("Kopírování se nepodařilo."),
    );
  });
  $("#btnTasksMail").addEventListener("click", () => {
    const rec = currentRec;
    const to = loadSettings().email;
    location.href = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(`Úkoly: ${rec.name}`)}&body=${encodeURIComponent(tasksText(rec))}`;
  });
  $("#btnTasksIcs").addEventListener("click", () => {
    const rec = currentRec;
    saveFile(`Úkoly – ${safeName(rec.name)}.ics`, tasksIcs(rec), "text/calendar", { preferShare: false });
  });

  // --- otázky ---
  $("#askQuick").innerHTML = ASK_QUICK.map(([l], i) => `<button type="button" class="qchip" data-i="${i}">${esc(l)}</button>`).join("");
  $("#askQuick").addEventListener("click", (e) => {
    const b = e.target.closest("[data-i]");
    if (!b || !currentRec) return;
    const [label, q] = ASK_QUICK[b.dataset.i];
    ask(currentRec, q, label);
  });
  const runAsk = () => {
    const q = $("#askInput").value.trim();
    if (!q || !currentRec) return;
    $("#askInput").value = "";
    ask(currentRec, q);
  };
  $("#askGo").addEventListener("click", runAsk);
  $("#askInput").addEventListener("keydown", (e) => e.key === "Enter" && runAsk());

  $("#sDefaultStyle").innerHTML = Object.entries(STYLES).map(([id, s]) => `<option value="${id}">${esc(s.label)}</option>`).join("");

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
