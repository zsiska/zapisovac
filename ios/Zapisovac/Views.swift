import AVFoundation
import SwiftUI
import UIKit
import UniformTypeIdentifiers

// MARK: - Hlavní obrazovka

struct ContentView: View {
    @EnvironmentObject private var lib: Library
    @EnvironmentObject private var recorder: Recorder
    @State private var path: [UUID] = []
    @State private var showSettings = false
    @State private var importing = false

    var body: some View {
        NavigationStack(path: $path) {
            List {
                Section {
                    RecorderPanel()
                        .frame(maxWidth: .infinity)
                        .listRowBackground(Color.clear)
                }
                Section {
                    Button {
                        importing = true
                    } label: {
                        Label("Importovat nahrávku (hovor, Diktafon)", systemImage: "square.and.arrow.down")
                    }
                } footer: {
                    Text("Nahrávku hovoru uložte z aplikace Poznámky do Souborů a pak ji tady importujte.")
                }
                Section("Nahrávky") {
                    if lib.items.isEmpty {
                        Text("Zatím žádné nahrávky.").foregroundStyle(.secondary)
                    }
                    ForEach(lib.items) { rec in
                        NavigationLink(value: rec.id) { RecordingRow(rec: rec) }
                    }
                    .onDelete { offsets in
                        offsets.map { lib.items[$0].id }.forEach(lib.delete)
                    }
                }
            }
            .navigationTitle("Zapisovač")
            .toolbar {
                Button {
                    showSettings = true
                } label: {
                    Image(systemName: "gearshape")
                }
            }
            .navigationDestination(for: UUID.self) { DetailView(id: $0) }
            .sheet(isPresented: $showSettings) { SettingsView() }
            .fileImporter(isPresented: $importing, allowedContentTypes: [.audio]) { result in
                guard case let .success(url) = result else { return }
                Task {
                    if let id = await Importer.importFile(url) { path = [id] }
                }
            }
            .onChange(of: recorder.finishedId) { _, id in
                if let id { path = [id] }
            }
            .onAppear {
                if AppSettings.missingKeys { showSettings = true }
            }
        }
    }
}

struct RecordingRow: View {
    let rec: Recording

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(rec.name).font(.body.weight(.semibold))
            Text(subtitle).font(.footnote).foregroundStyle(.secondary)
        }
    }

    private var subtitle: String {
        var parts: [String] = []
        if rec.duration > 0 { parts.append(clock(rec.duration)) }
        if rec.source == "import" { parts.append("import") }
        switch rec.status {
        case .recording: parts.append("nahrává se")
        case .processing: parts.append("zpracovává se…")
        case .error: parts.append("chyba")
        case .manual: parts.append("čeká na zápis")
        case .done: break
        }
        return parts.joined(separator: " · ")
    }
}

struct RecorderPanel: View {
    @EnvironmentObject private var recorder: Recorder

    var body: some View {
        VStack(spacing: 12) {
            Button {
                Task {
                    if recorder.isRecording { await recorder.stop() } else { await recorder.start() }
                }
            } label: {
                ZStack {
                    Circle().stroke(Color.secondary.opacity(0.3), lineWidth: 6).frame(width: 132, height: 132)
                    RoundedRectangle(cornerRadius: recorder.isRecording ? 10 : 38)
                        .fill(Color.red)
                        .frame(width: recorder.isRecording ? 48 : 76, height: recorder.isRecording ? 48 : 76)
                        .animation(.easeInOut(duration: 0.2), value: recorder.isRecording)
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel(recorder.isRecording ? "Ukončit nahrávání" : "Spustit nahrávání")

            Text(clock(recorder.elapsed))
                .font(.system(size: 40, weight: .light).monospacedDigit())
            Text(recorder.isRecording ? recorder.name : "Klepněte pro nahrávání")
                .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)

            if recorder.isRecording {
                Text(recorder.paused
                     ? "Pozastaveno (hovor). Po jeho skončení nahrávání samo pokračuje."
                     : "Telefon můžete zamknout – nahrávání poběží dál.")
                    .font(.footnote)
                    .foregroundStyle(recorder.paused ? Color.orange : Color.secondary)
                    .multilineTextAlignment(.center)
                ScrollView {
                    Text(recorder.liveText.isEmpty ? "Průběžný přepis se objeví za pár vteřin…" : recorder.liveText)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .font(.callout)
                }
                .frame(maxHeight: 180)
                .padding(10)
                .background(RoundedRectangle(cornerRadius: 12).fill(Color(.secondarySystemBackground)))
            }
            if let msg = recorder.message {
                Text(msg).font(.footnote).foregroundStyle(.red).multilineTextAlignment(.center)
            }
        }
        .padding(.vertical, 12)
    }
}

// MARK: - Detail nahrávky

struct DetailView: View {
    let id: UUID
    @EnvironmentObject private var lib: Library
    @EnvironmentObject private var processor: Processor
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var tab = 0
    @State private var shareItems: [Any]?
    @State private var confirmDelete = false
    @State private var info: String?

    var body: some View {
        if let rec = lib.get(id) {
            content(rec)
        } else {
            Text("Nahrávka nenalezena.").foregroundStyle(.secondary)
        }
    }

    private func content(_ rec: Recording) -> some View {
        let busy = processor.busy.contains(id)
        let manual = !rec.transcript.isEmpty && (rec.status == .manual || AppSettings.notesProvider == "claude-manual")
        return ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text([czDate(rec.created), rec.place, rec.duration > 0 ? clock(rec.duration) : ""]
                    .filter { !$0.isEmpty }.joined(separator: " · "))
                    .font(.footnote).foregroundStyle(.secondary)

                PlayerView(url: lib.url(rec))

                if let status = statusText(rec) {
                    Text(status)
                        .font(.callout)
                        .foregroundStyle(rec.status == .error ? Color.red : Color.primary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(12)
                        .background(RoundedRectangle(cornerRadius: 12).fill(Color(.secondarySystemBackground)))
                }

                if manual {
                    Button("1. Napsat zápis v aplikaci Claude") { openInClaude(rec) }
                        .buttonStyle(.borderedProminent).frame(maxWidth: .infinity)
                    Button("2. Vložit hotový zápis ze schránky") { pasteNotes(rec) }
                        .buttonStyle(.bordered).frame(maxWidth: .infinity)
                }

                Button {
                    email(rec)
                } label: {
                    Label("Poslat e-mailem", systemImage: "envelope").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(rec.notes.isEmpty || busy)

                HStack {
                    Button {
                        shareItems = shareContent(rec)
                    } label: {
                        Label("Sdílet", systemImage: "square.and.arrow.up").frame(maxWidth: .infinity)
                    }
                    Button {
                        UIPasteboard.general.string = rec.notes
                        info = "Zápis zkopírován."
                    } label: {
                        Label("Kopírovat", systemImage: "doc.on.doc").frame(maxWidth: .infinity)
                    }
                    .disabled(rec.notes.isEmpty)
                }
                .buttonStyle(.bordered)

                if let info { Text(info).font(.footnote).foregroundStyle(.secondary) }

                Picker("", selection: $tab) {
                    Text("Zápis").tag(0)
                    Text("Přepis").tag(1)
                }
                .pickerStyle(.segmented)

                Text(tab == 0 ? notesText(rec) : (rec.transcript.isEmpty ? (rec.live.isEmpty ? "Přepis zatím není." : rec.live) : rec.transcript))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(14)
                    .background(RoundedRectangle(cornerRadius: 12).fill(Color(.secondarySystemBackground)))

                HStack {
                    Button("Zpracovat znovu") { processor.process(id, redo: true) }
                        .disabled(busy || rec.status == .recording)
                    Spacer()
                    Button("Smazat", role: .destructive) { confirmDelete = true }
                        .disabled(rec.status == .recording)
                }
                .buttonStyle(.bordered)
            }
            .padding()
        }
        .navigationTitle(rec.name)
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: Binding(get: { shareItems != nil }, set: { if !$0 { shareItems = nil } })) {
            ActivityView(items: shareItems ?? [])
        }
        .confirmationDialog("Smazat nahrávku včetně zápisu?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Smazat", role: .destructive) {
                lib.delete(id)
                dismiss()
            }
        }
    }

    private func statusText(_ rec: Recording) -> String? {
        switch rec.status {
        case .processing: return rec.progress.isEmpty ? "Zpracovávám…" : rec.progress
        case .error: return rec.error
        case .manual: return "Přepis je hotový. Klepněte na 1. – přepis se zkopíruje a otevře se Claude. Tam ho vložte, a hotový zápis zkopírujte zpět tlačítkem 2."
        case .recording: return "Nahrává se…"
        case .done: return nil
        }
    }

    private func notesText(_ rec: Recording) -> String {
        if !rec.notes.isEmpty { return rec.notes }
        return rec.status == .processing ? "Zápis se připravuje…" : "Zápis zatím není."
    }

    private func email(_ rec: Recording) {
        var c = URLComponents()
        c.scheme = "mailto"
        c.path = AppSettings.email
        c.queryItems = [URLQueryItem(name: "subject", value: "Zápis: \(rec.name)"),
                        URLQueryItem(name: "body", value: rec.notes)]
        if let url = c.url { openURL(url) }
    }

    /// Text zápisu + zvuk pod čitelným názvem.
    private func shareContent(_ rec: Recording) -> [Any] {
        var items: [Any] = [rec.notes.isEmpty ? (rec.transcript.isEmpty ? rec.name : rec.transcript) : rec.notes]
        let src = lib.url(rec)
        let safe = rec.name.components(separatedBy: CharacterSet(charactersIn: "/\\:*?\"<>|")).joined(separator: "-")
        let dst = FileManager.default.temporaryDirectory.appendingPathComponent("\(safe).\(src.pathExtension)")
        try? FileManager.default.removeItem(at: dst)
        if (try? FileManager.default.copyItem(at: src, to: dst)) != nil { items.append(dst) }
        return items
    }

    private func openInClaude(_ rec: Recording) {
        UIPasteboard.general.string = "\(Notes.system)\n\n\(Notes.input(rec))"
        info = "Přepis zkopírován. V Claude podržte pole zprávy a dejte Vložit."
        if let url = URL(string: "https://claude.ai/new") { openURL(url) }
    }

    private func pasteNotes(_ rec: Recording) {
        let text = (UIPasteboard.general.string ?? "").trimmed
        guard !text.isEmpty, !text.contains("<prepis>") else {
            info = "Ve schránce není hotový zápis. V Claude ho nejdřív zkopírujte."
            return
        }
        lib.update(id) {
            $0.notes = text
            $0.status = .done
        }
        info = "Zápis vložen."
    }
}

struct ActivityView: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

// MARK: - Přehrávač

@MainActor
final class Player: NSObject, ObservableObject, AVAudioPlayerDelegate {
    @Published var playing = false
    @Published var position: Double = 0
    @Published var duration: Double = 0
    private var player: AVAudioPlayer?
    private var timer: Timer?

    func load(_ url: URL) {
        guard player == nil else { return }
        player = try? AVAudioPlayer(contentsOf: url)
        player?.delegate = self
        duration = player?.duration ?? 0
    }

    func toggle() {
        guard let player else { return }
        if playing {
            player.pause()
            playing = false
            timer?.invalidate()
            return
        }
        if !Recorder.shared.isRecording {
            try? AVAudioSession.sharedInstance().setCategory(.playback)
            try? AVAudioSession.sharedInstance().setActive(true)
        }
        player.play()
        playing = true
        timer = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: true) { _ in
            Task { @MainActor in self.position = self.player?.currentTime ?? 0 }
        }
    }

    func seek() {
        player?.currentTime = position
    }

    func stop() {
        player?.stop()
        playing = false
        timer?.invalidate()
    }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in
            self.playing = false
            self.position = 0
            self.timer?.invalidate()
        }
    }
}

struct PlayerView: View {
    let url: URL
    @StateObject private var player = Player()

    var body: some View {
        HStack(spacing: 12) {
            Button {
                player.toggle()
            } label: {
                Image(systemName: player.playing ? "pause.circle.fill" : "play.circle.fill")
                    .font(.system(size: 38))
            }
            .buttonStyle(.plain)
            Slider(value: $player.position, in: 0...max(player.duration, 0.1)) { editing in
                if !editing { player.seek() }
            }
            Text(clock(player.position)).font(.footnote.monospacedDigit()).foregroundStyle(.secondary)
        }
        .onAppear { player.load(url) }
        .onDisappear { player.stop() }
    }
}

// MARK: - Nastavení

struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @AppStorage("sttProvider") private var sttProvider = "groq"
    @AppStorage("groqKey") private var groqKey = ""
    @AppStorage("elevenKey") private var elevenKey = ""
    @AppStorage("notesProvider") private var notesProvider = "gemini"
    @AppStorage("geminiKey") private var geminiKey = ""
    @AppStorage("geminiModel") private var geminiModel = "gemini-3.6-flash"
    @AppStorage("anthropicKey") private var anthropicKey = ""
    @AppStorage("email") private var email = "zsiska@seznam.cz"

    var body: some View {
        NavigationStack {
            Form {
                Section("Přepis řeči") {
                    Picker("Služba", selection: $sttProvider) {
                        Text("Groq Whisper – zdarma").tag("groq")
                        Text("ElevenLabs – placené, rozliší mluvčí").tag("elevenlabs")
                    }
                    if sttProvider == "groq" {
                        SecureField("Groq API klíč", text: $groqKey)
                    } else {
                        SecureField("ElevenLabs API klíč", text: $elevenKey)
                    }
                }
                Section {
                    Picker("Služba", selection: $notesProvider) {
                        Text("Google Gemini – zdarma, automaticky").tag("gemini")
                        Text("Aplikace Claude – zdarma, ručně").tag("claude-manual")
                        Text("Claude API – placené, automaticky").tag("anthropic")
                    }
                    if notesProvider == "gemini" {
                        SecureField("Gemini API klíč", text: $geminiKey)
                        TextField("Model Gemini", text: $geminiModel)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                    }
                    if notesProvider == "anthropic" {
                        SecureField("Anthropic API klíč", text: $anthropicKey)
                    }
                } header: {
                    Text("Zápis ze schůzky")
                } footer: {
                    if notesProvider == "gemini" {
                        Text("V bezplatné verzi může Google obsah přepisů použít ke zlepšování svých služeb.")
                    }
                }
                Section {
                    TextField("E-mail pro zápisy", text: $email)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                } footer: {
                    Text("Klíče se ukládají jen v tomto telefonu a posílají se pouze přímo zvoleným službám.")
                }
            }
            .navigationTitle("Nastavení")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                Button("Hotovo") { dismiss() }
            }
        }
    }
}
