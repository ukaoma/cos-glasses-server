import Foundation
struct WorkMeetingReference: Identifiable, Hashable, Sendable {
    let recordId: String
    let domain: String
    let month: String
    let filename: String
    let title: String
    var id: String { recordId }
    var json: [String: String] { ["recordId": recordId, "domain": domain, "month": month, "filename": filename, "title": title] }
    var jsonValue: JSONValue { .object(json.mapValues { .string($0) }) }
    var libraryMeeting: LibraryMeeting? { LibraryMeeting(jsonValue) }

    init?(_ value: JSONValue?) {
        guard let row = value?.object,
              let recordId = row["recordId"]?.string, !recordId.isEmpty, recordId.utf8.count <= 2048,
              !recordId.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              let domain = row["domain"]?.string, domain.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil,
              let month = row["month"]?.string, month.range(of: "^[0-9]{4}-(0[1-9]|1[0-2])$", options: .regularExpression) != nil,
              let filename = row["filename"]?.string, !filename.isEmpty, filename.utf8.count <= 1024,
              filename != ".", filename != "..", !filename.contains("/"), !filename.contains("\\"),
              !filename.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { return nil }
        self.recordId = recordId; self.domain = domain; self.month = month; self.filename = filename
        title = row["title"]?.string ?? "Saved meeting"
    }

    init?(meeting: LibraryMeeting) {
        self.init(.object(["recordId": .string(meeting.recordId), "domain": .string(meeting.domain),
            "month": .string(meeting.month), "filename": .string(meeting.filename), "title": .string(meeting.title)]))
    }

    func matches(_ meeting: LibraryMeeting) -> Bool {
        recordId == meeting.recordId && domain == meeting.domain && month == meeting.month && filename == meeting.filename
    }
}
struct LibraryMeeting { init?(_ v: JSONValue) { return nil }; let recordId = ""; let domain = ""; let month = ""; let filename = ""; let title = "" }
