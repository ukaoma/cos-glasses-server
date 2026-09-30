import Foundation
struct TaskRow: Identifiable, Sendable {
    let id: String
    let ref: String
    let domain: String
    let title: String
    let column: String
    let section: String
    let due: Bool?
    let missed: Bool?
    let failed: Bool?
    let late: Bool?
    let carriedOver: Bool?
    let runAt: String
    /// Whole description. `title` is capped at 44 for a G2 lens row; a Mac
    /// window has no business rendering that cap. Server 6.44.3 and newer.
    let text: String
    let source: String
    let checked: Bool
    let agentState: String
    /// Board stage. Absent or unknown means planning, the unmarked default every
    /// captured row starts in, so an older server degrades to a full PLANNING lane
    /// rather than an empty board. Server 6.44.4 and newer.
    let stage: String
    /// What finished looks like. A dispatch is refused while this is empty: the
    /// server answers `run` with 409 done_when_required.
    let doneWhen: String
    /// Separate Work lifecycle metadata; legacy stage remains planning/active/review.
    let workStage: String
    let workIdentity: String
    let workRevision: String
    let meetingRefs: [WorkMeetingReference]
    let workMetadataError: String?
    static let workStages = ["mentioned", "planned", "draft", "built", "qa", "complete"]
    var workSourceID: String { "task:\(domain):\(workIdentity)" }

    var runAtDate: Date? {
        let trimmed = runAt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFraction.date(from: trimmed) { return date }
        let basic = ISO8601DateFormatter()
        basic.formatOptions = [.withInternetDateTime]
        if let date = basic.date(from: trimmed) { return date }
        // Control Schedule writes `yyyy-MM-dd HH:mm`, not ISO-8601.
        let local = DateFormatter()
        local.locale = Locale(identifier: "en_US_POSIX")
        local.dateFormat = "yyyy-MM-dd HH:mm"
        return local.date(from: trimmed)
    }

    init?(_ value: JSONValue?) {
        guard let o = value?.object, let id = o["id"]?.string, !id.isEmpty else { return nil }
        self.id = id
        ref = o["ref"]?.string ?? ""
        domain = o["domain"]?.string ?? ""
        title = o["title"]?.string ?? ""
        column = o["column"]?.string ?? ""
        section = o["section"]?.string ?? ""
        due = o["due"]?.bool
        missed = o["missed"]?.bool
        failed = o["failed"]?.bool
        late = o["late"]?.bool
        carriedOver = o["carriedOver"]?.bool
        runAt = o["runAt"]?.string ?? ""
        // Falls back to the capped title on an older server, so the detail view
        // shows something real rather than an empty body.
        text = o["text"]?.string ?? o["title"]?.string ?? ""
        source = o["source"]?.string ?? ""
        let rawStage = o["stage"]?.string ?? ""
        stage = (rawStage == "active" || rawStage == "review") ? rawStage : "planning"
        doneWhen = o["doneWhen"]?.string ?? ""
        checked = o["checked"]?.bool ?? false
        agentState = o["agentState"]?.string ?? ""
        let suppliedMetadataError = o["workMetadataError"]?.string?.trimmingCharacters(in: .whitespacesAndNewlines)
        var metadataError = suppliedMetadataError.flatMap { $0.isEmpty ? nil : $0 }
        let rawWorkStage = o["workStage"]?.string ?? ""
        workStage = Self.workStages.contains(rawWorkStage) ? rawWorkStage : (checked ? "complete" : stage == "active" ? "draft" : stage == "review" ? "qa" : "planned")
        if !rawWorkStage.isEmpty && !Self.workStages.contains(rawWorkStage) { metadataError = "Unsupported Work stage. Refresh before changing this task." }
        let identity = o["workIdentity"]?.string ?? id
        if identity.isEmpty || identity.utf8.count > 2048 || identity.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) {
            workIdentity = id; metadataError = "Invalid Work identity. Refresh before changing this task."
        } else { workIdentity = identity }
        workRevision = o["workRevision"]?.string ?? ""
        let rawRefs = o["meetingRefs"]?.array ?? []
        meetingRefs = rawRefs.compactMap { WorkMeetingReference($0) }
        if meetingRefs.count != rawRefs.count || (o["meetingRefs"] != nil && o["meetingRefs"]?.array == nil) {
            metadataError = "Some saved meeting references are invalid. Refresh before changing this task."
        }
        workMetadataError = metadataError
    }
}
