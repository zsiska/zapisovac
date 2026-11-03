import Foundation

enum RecStatus: String, Codable {
    case recording, processing, done, error, manual
}

struct Recording: Codable, Identifiable, Hashable {
    var id = UUID()
    var created = Date()
    var name: String
    var place = ""
    var duration: Double = 0
    var audioFile: String // název souboru ve složce Nahrávky
    var source = "mic"
    var live = ""
    var liveFailed = false
    var transcript = ""
    var notes = ""
    var status: RecStatus = .processing
    var progress = ""
    var error = ""
}

// Seznam nahrávek uložený jako JSON v Dokumentech; zvuk leží vedle ve složce Nahrávky
// (je vidět i v aplikaci Soubory → Na mém iPhonu → Zapisovač).
@MainActor
final class Library: ObservableObject {
    static let shared = Library()

    @Published private(set) var items: [Recording] = []
    let audioDir: URL
    private let indexURL: URL

    private init() {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        audioDir = docs.appendingPathComponent("Nahrávky", isDirectory: true)
        indexURL = docs.appendingPathComponent(".zapisovac.json")
        try? FileManager.default.createDirectory(at: audioDir, withIntermediateDirectories: true)
        if let data = try? Data(contentsOf: indexURL),
           let list = try? JSONDecoder().decode([Recording].self, from: data) {
            items = list
        }
    }

    private func save() {
        if let data = try? JSONEncoder().encode(items) {
            try? data.write(to: indexURL, options: .atomic)
        }
    }

    func get(_ id: UUID) -> Recording? {
        items.first { $0.id == id }
    }

    func upsert(_ rec: Recording) {
        if let i = items.firstIndex(where: { $0.id == rec.id }) {
            items[i] = rec
        } else {
            items.append(rec)
        }
        items.sort { $0.created > $1.created }
        save()
    }

    func update(_ id: UUID, _ change: (inout Recording) -> Void) {
        guard let i = items.firstIndex(where: { $0.id == id }) else { return }
        change(&items[i])
        save()
    }

    func delete(_ id: UUID) {
        if let rec = get(id) {
            try? FileManager.default.removeItem(at: url(rec))
        }
        items.removeAll { $0.id == id }
        save()
    }

    func url(_ rec: Recording) -> URL {
        audioDir.appendingPathComponent(rec.audioFile)
    }
}
