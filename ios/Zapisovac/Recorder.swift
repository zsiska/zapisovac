import AVFoundation
import Foundation

// Zapisuje zvuk z mikrofonu: celou nahrávku do .caf (vydrží i pád aplikace)
// a souběžně 20s úseky do .m4a pro průběžný přepis. Volá se z audio vlákna.
final class AudioWriter {
    var onSegment: ((URL) -> Void)?

    private let lock = NSLock()
    private var main: AVAudioFile?
    private var seg: AVAudioFile?
    private var segURL: URL?
    private var segFrames: AVAudioFramePosition = 0
    private var segLimit: AVAudioFramePosition = 0
    private var format: AVAudioFormat?

    private func aac(_ f: AVAudioFormat) -> [String: Any] {
        [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: f.sampleRate,
            AVNumberOfChannelsKey: f.channelCount,
            AVEncoderBitRateKey: 64000,
        ]
    }

    func start(mainURL: URL, format: AVAudioFormat, segmentSeconds: Double) throws {
        lock.lock()
        defer { lock.unlock() }
        self.format = format
        main = try AVAudioFile(forWriting: mainURL, settings: aac(format), commonFormat: .pcmFormatFloat32, interleaved: false)
        segLimit = AVAudioFramePosition(format.sampleRate * segmentSeconds)
        try newSegment()
    }

    func write(_ buffer: AVAudioPCMBuffer) {
        lock.lock()
        defer { lock.unlock() }
        try? main?.write(from: buffer)
        try? seg?.write(from: buffer)
        segFrames += AVAudioFramePosition(buffer.frameLength)
        if segFrames >= segLimit {
            finishSegment()
            try? newSegment()
        }
    }

    func stop() {
        lock.lock()
        defer { lock.unlock() }
        finishSegment()
        main = nil
    }

    private func newSegment() throws {
        guard let format else { return }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".m4a")
        seg = try AVAudioFile(forWriting: url, settings: aac(format), commonFormat: .pcmFormatFloat32, interleaved: false)
        segURL = url
        segFrames = 0
    }

    private func finishSegment() {
        guard let url = segURL, let format else { return }
        let frames = segFrames
        seg = nil // uvolnění souboru ho dokončí
        segURL = nil
        if frames > AVAudioFramePosition(format.sampleRate) {
            onSegment?(url)
        } else {
            try? FileManager.default.removeItem(at: url)
        }
    }
}

@MainActor
final class Recorder: ObservableObject {
    static let shared = Recorder()

    @Published private(set) var isRecording = false
    @Published private(set) var paused = false // přerušeno hovorem, po něm se samo obnoví
    @Published private(set) var elapsed: Double = 0
    @Published private(set) var name = ""
    @Published private(set) var liveText = ""
    @Published var message: String?
    @Published var finishedId: UUID?

    private let engine = AVAudioEngine()
    private let writer = AudioWriter()
    private var currentId: UUID?
    private var texts: [Int: String] = [:]
    private var segIndex = 0
    private var failed = false
    private var chain: Task<Void, Never>?
    private var runningSince: Date?
    private var accumulated: Double = 0
    private var timer: Timer?

    private init() {
        writer.onSegment = { url in
            Task { @MainActor in Recorder.shared.queueSegment(url) }
        }
        NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { note in
            guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
            Task { @MainActor in Recorder.shared.handleInterruption(type) }
        }
        NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: nil, queue: .main) { _ in
            Task { @MainActor in Recorder.shared.ensureRunning() }
        }
    }

    // MARK: start / stop

    func start() async {
        guard !isRecording else { return }
        message = nil
        guard await AVAudioApplication.requestRecordPermission() else {
            message = "Bez přístupu k mikrofonu nelze nahrávat. Povolte ho v Nastavení → Zapisovač."
            return
        }
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetooth])
            try session.setActive(true)
        } catch {
            message = "Mikrofon se nepodařilo zapnout: \(error.localizedDescription)"
            return
        }

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0 else {
            message = "Mikrofon není k dispozici."
            return
        }

        let now = Date()
        let id = UUID()
        var rec = Recording(id: id, created: now, name: stamp(now), audioFile: "\(id.uuidString).caf")
        rec.status = .recording
        let lib = Library.shared
        lib.upsert(rec)

        do {
            try writer.start(mainURL: lib.url(rec), format: format, segmentSeconds: 20)
        } catch {
            lib.delete(id)
            message = "Nahrávání nelze spustit: \(error.localizedDescription)"
            return
        }
        let writer = self.writer
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { buffer, _ in
            writer.write(buffer)
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            writer.stop()
            lib.delete(id)
            message = "Nahrávání nelze spustit: \(error.localizedDescription)"
            return
        }

        currentId = id
        texts = [:]
        segIndex = 0
        failed = AppSettings.sttKey.isEmpty
        chain = nil
        accumulated = 0
        runningSince = Date()
        elapsed = 0
        name = rec.name
        liveText = ""
        paused = false
        isRecording = true
        timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { _ in
            Task { @MainActor in Recorder.shared.tick() }
        }

        Task {
            let place = await Locator().placeName()
            guard !place.isEmpty else { return }
            let full = "\(stamp(now)) – \(place)"
            lib.update(id) {
                $0.place = place
                $0.name = full
            }
            if self.currentId == id { self.name = full }
        }
    }

    func stop() async {
        guard isRecording, let id = currentId else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        writer.stop()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        timer?.invalidate()
        tick()
        isRecording = false
        paused = false
        currentId = nil

        let lib = Library.shared
        let duration = elapsed
        lib.update(id) {
            $0.duration = duration
            $0.status = .processing
            $0.progress = "Dokončuji přepis…"
        }
        finishedId = id

        // Počkat na přepis posledního úseku.
        try? await Task.sleep(for: .milliseconds(300))
        await chain?.value
        let live = joinedLive()
        let liveFailed = failed
        lib.update(id) {
            $0.live = live
            $0.liveFailed = liveFailed
        }
        await Recorder.convertToM4A(id)
        Processor.shared.process(id)
    }

    // MARK: přerušení (hovor, Siri, budík…)

    private func handleInterruption(_ type: AVAudioSession.InterruptionType) {
        guard isRecording else { return }
        switch type {
        case .began:
            pauseClock()
            paused = true
        case .ended:
            resume(attempt: 0)
        @unknown default:
            break
        }
    }

    /// Volá se i při návratu do aplikace – kdyby iOS neposlal „konec přerušení“.
    func ensureRunning() {
        guard isRecording, !engine.isRunning else { return }
        pauseClock()
        paused = true
        resume(attempt: 0)
    }

    private func resume(attempt: Int) {
        do {
            try AVAudioSession.sharedInstance().setActive(true)
            if !engine.isRunning { try engine.start() }
            paused = false
            if runningSince == nil { runningSince = Date() }
        } catch {
            guard attempt < 10 else {
                message = "Nahrávání se po přerušení nepodařilo obnovit. Klepněte na tlačítko pro ukončení."
                return
            }
            Task {
                try? await Task.sleep(for: .seconds(1))
                self.resume(attempt: attempt + 1)
            }
        }
    }

    // MARK: čas

    private func pauseClock() {
        if let since = runningSince { accumulated += Date().timeIntervalSince(since) }
        runningSince = nil
    }

    private func tick() {
        elapsed = accumulated + (runningSince.map { Date().timeIntervalSince($0) } ?? 0)
    }

    // MARK: průběžný přepis

    fileprivate func queueSegment(_ url: URL) {
        let idx = segIndex
        segIndex += 1
        guard !AppSettings.sttKey.isEmpty else {
            failed = true
            try? FileManager.default.removeItem(at: url)
            return
        }
        let previous = chain
        let id = currentId
        chain = Task {
            await previous?.value
            do {
                self.texts[idx] = try await Transcriber.transcribe(url)
                let live = self.joinedLive()
                if self.currentId == id { self.liveText = live }
                if let id { Library.shared.update(id) { $0.live = live } }
            } catch {
                self.failed = true
                if self.currentId == id { self.message = error.localizedDescription }
            }
            try? FileManager.default.removeItem(at: url)
        }
    }

    private func joinedLive() -> String {
        texts.keys.sorted().compactMap { texts[$0] }.filter { !$0.isEmpty }.joined(separator: " ")
    }

    // MARK: převod

    /// .caf → .m4a (menší, lépe se sdílí). Když převod selže, zůstane .caf.
    static func convertToM4A(_ id: UUID) async {
        let lib = Library.shared
        guard let rec = lib.get(id), rec.audioFile.hasSuffix(".caf") else { return }
        let src = lib.url(rec)
        let file = "\(id.uuidString).m4a"
        let dst = lib.audioDir.appendingPathComponent(file)
        do {
            try await AudioTools.export(src, to: dst)
            lib.update(id) { $0.audioFile = file }
            try? FileManager.default.removeItem(at: src)
        } catch {
            // necháme .caf; přepis si ho převede sám
        }
    }
}

// Aplikace byla ukončena uprostřed nahrávání nebo zpracování → dokončit.
@MainActor
enum Recovery {
    static func run() {
        let lib = Library.shared
        for rec in lib.items where rec.status == .recording || rec.status == .processing {
            let id = rec.id
            Task {
                guard FileManager.default.fileExists(atPath: lib.url(rec).path) else {
                    lib.update(id) {
                        $0.status = .error
                        $0.error = "Zvuk se neuložil."
                    }
                    return
                }
                if rec.status == .recording {
                    let duration = await AudioTools.duration(lib.url(rec))
                    lib.update(id) {
                        $0.status = .processing
                        $0.liveFailed = true
                        $0.duration = duration
                    }
                    await Recorder.convertToM4A(id)
                }
                Processor.shared.process(id)
            }
        }
    }
}
