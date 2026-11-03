import Foundation

struct AppError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

func clock(_ seconds: Double) -> String {
    let s = Int(seconds.rounded())
    let h = s / 3600, m = (s % 3600) / 60, r = s % 60
    return h > 0 ? String(format: "%d:%02d:%02d", h, m, r) : String(format: "%02d:%02d", m, r)
}

func stamp(_ date: Date) -> String {
    let f = DateFormatter()
    f.locale = Locale(identifier: "cs_CZ")
    f.dateFormat = "yyyy-MM-dd HH-mm"
    return f.string(from: date)
}

func czDate(_ date: Date) -> String {
    let f = DateFormatter()
    f.locale = Locale(identifier: "cs_CZ")
    f.dateStyle = .medium
    f.timeStyle = .short
    return f.string(from: date)
}

extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}

// Nastavení – stejné volby jako ve webové verzi. Klíče zůstávají jen v telefonu.
enum AppSettings {
    static let defaults: [String: Any] = [
        "sttProvider": "groq",
        "groqKey": "",
        "elevenKey": "",
        "notesProvider": "gemini",
        "geminiKey": "",
        "geminiModel": "gemini-3.6-flash",
        "anthropicKey": "",
        "email": "zsiska@seznam.cz",
    ]

    private static func value(_ key: String) -> String {
        (UserDefaults.standard.string(forKey: key) ?? defaults[key] as? String ?? "").trimmed
    }

    static var sttProvider: String { value("sttProvider") }
    static var groqKey: String { value("groqKey") }
    static var elevenKey: String { value("elevenKey") }
    static var notesProvider: String { value("notesProvider") }
    static var geminiKey: String { value("geminiKey") }
    static var geminiModel: String { value("geminiModel").isEmpty ? "gemini-3.6-flash" : value("geminiModel") }
    static var anthropicKey: String { value("anthropicKey") }
    static var email: String { value("email") }

    static var sttKey: String { sttProvider == "elevenlabs" ? elevenKey : groqKey }

    static var missingKeys: Bool {
        sttKey.isEmpty
            || (notesProvider == "gemini" && geminiKey.isEmpty)
            || (notesProvider == "anthropic" && anthropicKey.isEmpty)
    }
}
