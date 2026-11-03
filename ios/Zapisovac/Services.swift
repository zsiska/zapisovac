import AVFoundation
import CoreLocation
import Foundation

// MARK: - Zvuk

@MainActor
enum AudioTools {
    static let uploadable: Set<String> = ["m4a", "mp3", "mp4", "wav", "ogg", "flac", "webm", "mpeg", "mpga"]

    static func duration(_ url: URL) async -> Double {
        guard let time = try? await AVURLAsset(url: url).load(.duration) else { return 0 }
        return time.seconds.isFinite ? time.seconds : 0
    }

    static func export(_ url: URL, to out: URL, range: CMTimeRange? = nil) async throws {
        let asset = AVURLAsset(url: url)
        guard let session = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetAppleM4A) else {
            throw AppError("Zvuk nelze převést.")
        }
        try? FileManager.default.removeItem(at: out)
        session.outputURL = out
        session.outputFileType = .m4a
        if let range { session.timeRange = range }
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            session.exportAsynchronously { cont.resume() }
        }
        if session.status != .completed {
            throw AppError("Převod zvuku selhal: \(session.error?.localizedDescription ?? "neznámá chyba")")
        }
    }

    /// Rozdělí nahrávku na .m4a úseky (pro služby s limitem velikosti souboru).
    static func split(_ url: URL, seconds: Double) async throws -> [URL] {
        let total = await duration(url)
        var parts: [URL] = []
        var start = 0.0
        repeat {
            let out = FileManager.default.temporaryDirectory.appendingPathComponent("usek-\(UUID().uuidString).m4a")
            let length = total > 0 ? min(seconds, total - start) : seconds
            let range = CMTimeRange(start: CMTime(seconds: start, preferredTimescale: 600),
                                    duration: CMTime(seconds: length, preferredTimescale: 600))
            try await export(url, to: out, range: total > 0 ? range : nil)
            parts.append(out)
            start += seconds
        } while start < total
        return parts
    }
}

// MARK: - Poloha

@MainActor
final class Locator: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var cont: CheckedContinuation<CLLocation?, Never>?

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
    }

    func placeName() async -> String {
        guard let loc = await location() else { return "" }
        if let mark = try? await CLGeocoder().reverseGeocodeLocation(loc, preferredLocale: Locale(identifier: "cs_CZ")).first {
            let street = [mark.thoroughfare, mark.subThoroughfare].compactMap { $0 }.joined(separator: " ")
            let town = mark.locality ?? ""
            let name = [street, town].filter { !$0.isEmpty }.joined(separator: ", ")
            if !name.isEmpty { return name }
        }
        return String(format: "%.5f, %.5f", loc.coordinate.latitude, loc.coordinate.longitude)
    }

    private func location() async -> CLLocation? {
        await withCheckedContinuation { c in
            cont = c
            switch manager.authorizationStatus {
            case .notDetermined:
                manager.requestWhenInUseAuthorization() // pokračuje v locationManagerDidChangeAuthorization
            case .authorizedWhenInUse, .authorizedAlways:
                manager.requestLocation()
            default:
                finish(nil)
            }
            Task {
                try? await Task.sleep(for: .seconds(15))
                self.finish(nil)
            }
        }
    }

    private func finish(_ loc: CLLocation?) {
        cont?.resume(returning: loc)
        cont = nil
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        Task { @MainActor in
            switch self.manager.authorizationStatus {
            case .authorizedWhenInUse, .authorizedAlways: if self.cont != nil { self.manager.requestLocation() }
            case .notDetermined: break
            default: self.finish(nil)
            }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        let last = locations.last
        Task { @MainActor in self.finish(last) }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in self.finish(nil) }
    }
}

// MARK: - Přepis

struct Multipart {
    let boundary = "Boundary-\(UUID().uuidString)"
    private var data = Data()

    mutating func field(_ name: String, _ value: String) {
        data.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".utf8))
    }

    mutating func file(_ name: String, _ url: URL) throws {
        let content = try Data(contentsOf: url)
        let mime = url.pathExtension.lowercased() == "wav" ? "audio/wav" : "audio/mp4"
        data.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"; filename=\"\(url.lastPathComponent)\"\r\nContent-Type: \(mime)\r\n\r\n".utf8))
        data.append(content)
        data.append(Data("\r\n".utf8))
    }

    func body() -> Data {
        data + Data("--\(boundary)--\r\n".utf8)
    }
}

@MainActor
enum Transcriber {
    static let maxUpload = 24 * 1024 * 1024 // Groq zdarma bere soubory do 25 MB
    // Whisper si v tichu občas „vymyslí“ titulky – takové úseky zahodíme.
    static let hallucination = try! NSRegularExpression(
        pattern: "titulky|subtitles|www\\.|děkuji za pozornost|ďakujem za pozornosť",
        options: .caseInsensitive)

    static func transcribe(_ url: URL, diarize: Bool = false) async throws -> String {
        AppSettings.sttProvider == "elevenlabs" ? try await eleven(url, diarize: diarize) : try await groq(url)
    }

    /// Celá nahrávka: ElevenLabs najednou s mluvčími, Groq po 10min úsecích, je-li velká.
    static func transcribeFile(_ url: URL, progress: (String) -> Void) async throws -> String {
        let ext = url.pathExtension.lowercased()
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        if AppSettings.sttProvider == "elevenlabs" {
            progress("Přepisuji nahrávku a rozlišuji mluvčí…")
            if uploadableAs(ext) { return try await transcribe(url, diarize: true) }
            let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).m4a")
            try await AudioTools.export(url, to: tmp)
            defer { try? FileManager.default.removeItem(at: tmp) }
            return try await transcribe(tmp, diarize: true)
        }
        if uploadableAs(ext) && size <= maxUpload {
            progress("Přepisuji nahrávku…")
            return try await transcribe(url)
        }
        progress("Připravuji nahrávku…")
        let parts = try await AudioTools.split(url, seconds: 600)
        var out: [String] = []
        for (i, part) in parts.enumerated() {
            progress(parts.count > 1 ? "Přepisuji úsek \(i + 1) z \(parts.count)…" : "Přepisuji nahrávku…")
            out.append(try await transcribe(part))
            try? FileManager.default.removeItem(at: part)
        }
        return out.joined(separator: " ").trimmed
    }

    private static func uploadableAs(_ ext: String) -> Bool {
        AudioTools.uploadable.contains(ext)
    }

    private static func groq(_ url: URL) async throws -> String {
        let key = AppSettings.groqKey
        guard !key.isEmpty else { throw AppError("Chybí Groq API klíč – doplňte ho v Nastavení.") }
        var form = Multipart()
        try form.file("file", url)
        form.field("model", "whisper-large-v3")
        form.field("response_format", "verbose_json")
        form.field("temperature", "0")
        form.field("prompt", "Pracovní schůzka v češtině, případně ve slovenčine.")
        let data = try await post("https://api.groq.com/openai/v1/audio/transcriptions",
                                  headers: ["Authorization": "Bearer \(key)"], form: form, service: "Groq")
        struct Response: Decodable {
            struct Segment: Decodable {
                let text: String
                let no_speech_prob: Double?
            }
            let text: String?
            let segments: [Segment]?
        }
        let r = try JSONDecoder().decode(Response.self, from: data)
        guard let segments = r.segments else { return (r.text ?? "").trimmed }
        return segments
            .filter { ($0.no_speech_prob ?? 0) < 0.6 && !isHallucination($0.text) }
            .map { $0.text.trimmed }
            .joined(separator: " ")
            .trimmed
    }

    private static func isHallucination(_ text: String) -> Bool {
        hallucination.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }

    private static func eleven(_ url: URL, diarize: Bool) async throws -> String {
        let key = AppSettings.elevenKey
        guard !key.isEmpty else { throw AppError("Chybí ElevenLabs API klíč – doplňte ho v Nastavení.") }
        var form = Multipart()
        try form.file("file", url)
        form.field("model_id", "scribe_v2")
        form.field("tag_audio_events", "false")
        if diarize { form.field("diarize", "true") }
        let data = try await post("https://api.elevenlabs.io/v1/speech-to-text",
                                  headers: ["xi-api-key": key], form: form, service: "ElevenLabs")
        struct Response: Decodable {
            struct Word: Decodable {
                let text: String
                let type: String?
                let speaker_id: String?
            }
            let text: String?
            let words: [Word]?
        }
        let r = try JSONDecoder().decode(Response.self, from: data)
        let words = (r.words ?? []).filter { $0.type != "audio_event" }
        guard diarize, words.contains(where: { $0.speaker_id != nil }) else { return (r.text ?? "").trimmed }
        // Odstavce „Mluvčí N: …“ podle speaker_id.
        func label(_ id: String?) -> String {
            let n = Int((id ?? "").filter(\.isNumber)) ?? 0
            return "Mluvčí \(n + 1)"
        }
        var lines: [String] = []
        var speaker: String?
        var buf = ""
        for w in words {
            if w.type == "word", let s = w.speaker_id, s != speaker {
                if !buf.trimmed.isEmpty { lines.append("\(label(speaker)): \(buf.trimmed)") }
                speaker = s
                buf = ""
            }
            buf += w.text
        }
        if !buf.trimmed.isEmpty { lines.append("\(label(speaker)): \(buf.trimmed)") }
        return lines.joined(separator: "\n\n")
    }

    private static func post(_ url: String, headers: [String: String], form: Multipart, service: String) async throws -> Data {
        var req = URLRequest(url: URL(string: url)!)
        req.httpMethod = "POST"
        req.timeoutInterval = 600
        headers.forEach { req.setValue($0.value, forHTTPHeaderField: $0.key) }
        req.setValue("multipart/form-data; boundary=\(form.boundary)", forHTTPHeaderField: "Content-Type")
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.upload(for: req, from: form.body())
        } catch {
            throw AppError("Přepis selhal: nejste připojeni k internetu.")
        }
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        if code == 401 { throw AppError("Přepis selhal: neplatný \(service) klíč.") }
        if code == 429 { throw AppError("Přepis selhal: vyčerpaný limit \(service), zkuste to později.") }
        guard (200..<300).contains(code) else {
            throw AppError("Přepis selhal (\(code)): \(String(decoding: data.prefix(200), as: UTF8.self))")
        }
        return data
    }
}

// MARK: - Zápis ze schůzky

@MainActor
enum Notes {
    static let system = """
    Jsi pečlivý zapisovatel porad. Dostaneš automatický přepis řeči ze schůzky nebo telefonního hovoru, v češtině nebo slovenštině (i střídavě). Přepis může obsahovat chyby rozpoznávání; mluvčí mohou být označeni „Mluvčí 1“, „Mluvčí 2“ atd. – pokud z obsahu vyplyne jejich jméno nebo role, použij ho. Zápis piš vždy česky.

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

    Sekce, ke kterým přepis nic neobsahuje, vynech. Pokud jde o krátkou poznámku nebo hovor, přizpůsob rozsah. Nevymýšlej nic, co v přepisu není; nejasná místa označ [nejasné].
    """

    static func input(_ rec: Recording) -> String {
        """
        Datum a čas: \(czDate(rec.created))
        Místo: \(rec.place.isEmpty ? "neuvedeno" : rec.place)
        Délka: \(rec.duration > 0 ? clock(rec.duration) : "neuvedeno")

        <prepis>
        \(rec.transcript)
        </prepis>
        """
    }

    static func make(_ rec: Recording, onText: (String) -> Void) async throws -> String {
        AppSettings.notesProvider == "anthropic" ? try await claude(rec, onText: onText) : try await gemini(rec, onText: onText)
    }

    private static func stream(_ req: URLRequest) async throws -> (URLSession.AsyncBytes, Int) {
        do {
            let (bytes, response) = try await URLSession.shared.bytes(for: req)
            return (bytes, (response as? HTTPURLResponse)?.statusCode ?? 0)
        } catch {
            throw AppError("Zápis selhal: nejste připojeni k internetu.")
        }
    }

    private static func readAll(_ bytes: URLSession.AsyncBytes) async -> String {
        var body = ""
        do {
            for try await line in bytes.lines { body += line }
        } catch {}
        return body
    }

    private static func json(_ line: String) -> [String: Any]? {
        guard line.hasPrefix("data:") else { return nil }
        let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
        return (try? JSONSerialization.jsonObject(with: Data(payload.utf8))) as? [String: Any]
    }

    private static func gemini(_ rec: Recording, onText: (String) -> Void) async throws -> String {
        let key = AppSettings.geminiKey
        guard !key.isEmpty else { throw AppError("Chybí Gemini API klíč – doplňte ho v Nastavení.") }
        let model = AppSettings.geminiModel
        let path = model.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? model
        var req = URLRequest(url: URL(string: "https://generativelanguage.googleapis.com/v1beta/models/\(path):streamGenerateContent?alt=sse")!)
        req.httpMethod = "POST"
        req.timeoutInterval = 600
        req.setValue(key, forHTTPHeaderField: "x-goog-api-key")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: [
            "systemInstruction": ["parts": [["text": system]]],
            "contents": [["role": "user", "parts": [["text": input(rec)]]]],
            "generationConfig": ["maxOutputTokens": 32768],
        ])
        let (bytes, code) = try await stream(req)
        guard (200..<300).contains(code) else {
            let body = await readAll(bytes)
            if body.contains("API_KEY_INVALID") || body.contains("API key not valid") { throw AppError("Zápis selhal: neplatný Gemini klíč.") }
            if code == 429 { throw AppError("Zápis selhal: vyčerpaný bezplatný limit Gemini, zkuste to později.") }
            if code == 404 { throw AppError("Zápis selhal: model „\(model)“ neexistuje – změňte ho v Nastavení.") }
            throw AppError("Zápis selhal (\(code)): \(body.prefix(200))")
        }
        var text = ""
        var finish = ""
        for try await line in bytes.lines {
            guard let event = json(line),
                  let cand = (event["candidates"] as? [[String: Any]])?.first else { continue }
            let parts = ((cand["content"] as? [String: Any])?["parts"] as? [[String: Any]]) ?? []
            for p in parts where (p["thought"] as? Bool) != true {
                if let t = p["text"] as? String {
                    text += t
                    onText(text)
                }
            }
            if let f = cand["finishReason"] as? String { finish = f }
        }
        guard !text.isEmpty else {
            throw AppError(finish.contains("SAFETY") || finish.contains("PROHIBITED") ? "Gemini odmítl tento přepis zpracovat." : "Gemini nevrátil žádný text.")
        }
        return text.trimmed
    }

    // Claude API přes HTTP (pro Swift není oficiální SDK).
    private static func claude(_ rec: Recording, onText: (String) -> Void) async throws -> String {
        let key = AppSettings.anthropicKey
        guard !key.isEmpty else { throw AppError("Chybí Anthropic API klíč – doplňte ho v Nastavení.") }
        var req = URLRequest(url: URL(string: "https://api.anthropic.com/v1/messages")!)
        req.httpMethod = "POST"
        req.timeoutInterval = 900
        req.setValue(key, forHTTPHeaderField: "x-api-key")
        req.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
        req.setValue("server-side-fallback-2026-07-01", forHTTPHeaderField: "anthropic-beta")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: [
            "model": "claude-opus-5-5",
            "max_tokens": 64000,
            "stream": true,
            "fallbacks": "default",
            "thinking": ["type": "adaptive"],
            "output_config": ["effort": "medium"],
            "system": system,
            "messages": [["role": "user", "content": input(rec)]],
        ] as [String: Any])
        let (bytes, code) = try await stream(req)
        guard (200..<300).contains(code) else {
            let body = await readAll(bytes)
            if code == 401 { throw AppError("Zápis selhal: neplatný Anthropic klíč.") }
            if code == 429 { throw AppError("Zápis selhal: příliš mnoho požadavků, zkuste to za chvíli.") }
            throw AppError("Zápis selhal (\(code)): \(body.prefix(200))")
        }
        var text = ""
        for try await line in bytes.lines {
            guard let event = json(line) else { continue }
            switch event["type"] as? String {
            case "content_block_delta":
                if let delta = event["delta"] as? [String: Any], delta["type"] as? String == "text_delta",
                   let t = delta["text"] as? String {
                    text += t
                    onText(text)
                }
            case "message_delta":
                if (event["delta"] as? [String: Any])?["stop_reason"] as? String == "refusal" {
                    throw AppError("Model odmítl tento přepis zpracovat.")
                }
            case "error":
                let msg = (event["error"] as? [String: Any])?["message"] as? String ?? "neznámá chyba"
                throw AppError("Zápis selhal: \(msg)")
            default:
                break
            }
        }
        return text.trimmed
    }
}

// MARK: - Zpracování nahrávky

@MainActor
final class Processor: ObservableObject {
    static let shared = Processor()
    @Published private(set) var busy: Set<UUID> = []

    /// redo = přepsat znovu celý zvuk (jinak se u Groq použije průběžný přepis).
    func process(_ id: UUID, redo: Bool = false) {
        guard !busy.contains(id) else { return }
        busy.insert(id)
        Task {
            await run(id, redo: redo)
            busy.remove(id)
        }
    }

    private func run(_ id: UUID, redo: Bool) async {
        let lib = Library.shared
        guard let start = lib.get(id) else { return }
        func set(_ change: (inout Recording) -> Void) { lib.update(id, change) }
        let live = !redo && !start.liveFailed ? start.live : ""
        do {
            set {
                $0.status = .processing
                $0.error = ""
            }
            if !live.isEmpty && AppSettings.sttProvider != "elevenlabs" {
                set { $0.transcript = live }
            } else {
                do {
                    let text = try await Transcriber.transcribeFile(lib.url(start)) { p in set { $0.progress = p } }
                    set { $0.transcript = text }
                } catch {
                    if live.isEmpty { throw error }
                    set { $0.transcript = live }
                }
            }
            guard let rec = lib.get(id), !rec.transcript.isEmpty else {
                throw AppError("V nahrávce nebyla rozpoznána žádná řeč.")
            }
            if AppSettings.notesProvider == "claude-manual" {
                set {
                    $0.status = .manual
                    $0.progress = ""
                }
                return
            }
            set {
                $0.progress = "Píšu zápis ze schůzky…"
                $0.notes = ""
            }
            var last = Date.distantPast
            let notes = try await Notes.make(rec) { text in
                if Date().timeIntervalSince(last) > 0.25 {
                    last = Date()
                    set { $0.notes = text }
                }
            }
            set {
                $0.notes = notes
                $0.status = .done
                $0.progress = ""
            }
        } catch {
            set {
                $0.status = .error
                $0.progress = ""
                $0.error = error.localizedDescription
            }
        }
    }
}

// MARK: - Import

@MainActor
enum Importer {
    static func importFile(_ src: URL) async -> UUID? {
        let scoped = src.startAccessingSecurityScopedResource()
        defer { if scoped { src.stopAccessingSecurityScopedResource() } }
        let lib = Library.shared
        let id = UUID()
        let ext = src.pathExtension.isEmpty ? "m4a" : src.pathExtension.lowercased()
        let file = "\(id.uuidString).\(ext)"
        let dst = lib.audioDir.appendingPathComponent(file)
        do {
            try FileManager.default.copyItem(at: src, to: dst)
        } catch {
            return nil
        }
        let modified = (try? src.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? Date()
        var rec = Recording(id: id, created: modified,
                            name: "\(stamp(modified)) – \(src.deletingPathExtension().lastPathComponent)",
                            audioFile: file)
        rec.source = "import"
        rec.duration = await AudioTools.duration(dst)
        lib.upsert(rec)
        Processor.shared.process(id)
        return id
    }
}
