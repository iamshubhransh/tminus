import Foundation

/// Mirror of the collector's `LiveState` (packages/core/src/state.ts), schema `v: 1`.
///
/// Decoding is deliberately forgiving: unknown fields are ignored, a field of the
/// wrong type falls back to a default instead of failing the whole document, and
/// malformed history entries are skipped. Only a document whose `v` is not `1`
/// (or that is not a JSON object at all) is rejected.
public struct LiveState: Equatable, Sendable {
    public enum Status: String, Equatable, Sendable {
        case running, waiting, done, idle
    }

    public struct Todo: Equatable, Sendable {
        public var done: Int
        public var total: Int
        public init(done: Int, total: Int) {
            self.done = done
            self.total = total
        }
        /// 0...1, or 0 when the list is empty.
        public var fraction: Double {
            total > 0 ? min(1, max(0, Double(done) / Double(total))) : 0
        }
    }

    public struct Turn: Equatable, Sendable {
        public var submittedAt: Double
        public var elapsedMs: Double
        public var idleMs: Double
        public var intent: String
        public var p10RemainingMs: Double
        public var p50RemainingMs: Double
        public var p90RemainingMs: Double
        public var p50TotalMs: Double
        public var p90TotalMs: Double
        public var overrun: Bool
        public var todo: Todo?
        public var toolCalls: Int
        public var waitingSince: Double?
        public var waitingReason: String?

        public init(
            submittedAt: Double = 0, elapsedMs: Double = 0, idleMs: Double = 0, intent: String = "other",
            p10RemainingMs: Double = 0, p50RemainingMs: Double = 0, p90RemainingMs: Double = 0,
            p50TotalMs: Double = 0, p90TotalMs: Double = 0, overrun: Bool = false, todo: Todo? = nil,
            toolCalls: Int = 0, waitingSince: Double? = nil, waitingReason: String? = nil
        ) {
            self.submittedAt = submittedAt
            self.elapsedMs = elapsedMs
            self.idleMs = idleMs
            self.intent = intent
            self.p10RemainingMs = p10RemainingMs
            self.p50RemainingMs = p50RemainingMs
            self.p90RemainingMs = p90RemainingMs
            self.p50TotalMs = p50TotalMs
            self.p90TotalMs = p90TotalMs
            self.overrun = overrun
            self.todo = todo
            self.toolCalls = toolCalls
            self.waitingSince = waitingSince
            self.waitingReason = waitingReason
        }
    }

    /// A finished turn (`last`, and each entry of `history`).
    public struct Finished: Equatable, Sendable {
        public var finishedAt: Double
        public var actualMs: Double
        public var p50Ms: Double?
        public var p90Ms: Double?
        public var outcome: String
        public var intent: String

        public init(finishedAt: Double, actualMs: Double, p50Ms: Double?, p90Ms: Double?, outcome: String, intent: String) {
            self.finishedAt = finishedAt
            self.actualMs = actualMs
            self.p50Ms = p50Ms
            self.p90Ms = p90Ms
            self.outcome = outcome
            self.intent = intent
        }

        public var isCompleted: Bool { outcome == "completed" }
    }

    public var v: Int
    public var agent: String
    public var sessionId: String
    public var project: String?
    public var status: Status
    public var updatedAt: Double
    public var turn: Turn?
    public var last: Finished?
    /// Newest first, up to 10.
    public var history: [Finished]

    public init(
        agent: String = "claude-code", sessionId: String = "", project: String? = nil, status: Status = .idle,
        updatedAt: Double = 0, turn: Turn? = nil, last: Finished? = nil, history: [Finished] = []
    ) {
        self.v = 1
        self.agent = agent
        self.sessionId = sessionId
        self.project = project
        self.status = status
        self.updatedAt = updatedAt
        self.turn = turn
        self.last = last
        self.history = history
    }
}

// MARK: - Lenient decoding

/// Any JSON key; lets us look fields up by name and ignore everything else.
struct AnyKey: CodingKey {
    var stringValue: String
    var intValue: Int?
    init(_ s: String) { stringValue = s; intValue = nil }
    init?(stringValue: String) { self.stringValue = stringValue; intValue = nil }
    init?(intValue: Int) { self.stringValue = String(intValue); self.intValue = intValue }
}

extension KeyedDecodingContainer where Key == AnyKey {
    func num(_ key: String) -> Double? {
        let k = AnyKey(key)
        if let d = try? decodeIfPresent(Double.self, forKey: k) { return d.isFinite ? d : nil }
        if let s = try? decodeIfPresent(String.self, forKey: k), let d = Double(s), d.isFinite { return d }
        return nil
    }
    func int(_ key: String) -> Int? {
        guard let d = num(key), d.isFinite, abs(d) < 1e15 else { return nil }
        return Int(d.rounded())
    }
    func str(_ key: String) -> String? {
        (try? decodeIfPresent(String.self, forKey: AnyKey(key))) ?? nil
    }
    func bool(_ key: String) -> Bool? {
        (try? decodeIfPresent(Bool.self, forKey: AnyKey(key))) ?? nil
    }
    func obj(_ key: String) -> KeyedDecodingContainer<AnyKey>? {
        let k = AnyKey(key)
        guard contains(k), (try? decodeNil(forKey: k)) == false else { return nil }
        return try? nestedContainer(keyedBy: AnyKey.self, forKey: k)
    }
}

/// Decodes to `nil` instead of throwing, so one bad array element doesn't sink the array.
struct Lossy<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) throws {
        value = try? T(from: decoder)
    }
}

extension LiveState.Todo {
    init?(_ c: KeyedDecodingContainer<AnyKey>?) {
        guard let c, let total = c.int("total") else { return nil }
        self.init(done: max(0, c.int("done") ?? 0), total: max(0, total))
    }
}

extension LiveState.Finished: Decodable {
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        guard let finishedAt = c.num("finishedAt"), let actualMs = c.num("actualMs") else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "finished turn needs finishedAt and actualMs"))
        }
        self.init(
            finishedAt: finishedAt,
            actualMs: max(0, actualMs),
            p50Ms: c.num("p50Ms").flatMap { $0 > 0 ? $0 : nil },
            p90Ms: c.num("p90Ms").flatMap { $0 > 0 ? $0 : nil },
            outcome: c.str("outcome") ?? "completed",
            intent: c.str("intent") ?? "other"
        )
    }
}

extension LiveState.Turn {
    init(_ c: KeyedDecodingContainer<AnyKey>) {
        self.init(
            submittedAt: c.num("submittedAt") ?? 0,
            elapsedMs: max(0, c.num("elapsedMs") ?? 0),
            idleMs: max(0, c.num("idleMs") ?? 0),
            intent: c.str("intent") ?? "other",
            p10RemainingMs: max(0, c.num("p10RemainingMs") ?? 0),
            p50RemainingMs: max(0, c.num("p50RemainingMs") ?? 0),
            p90RemainingMs: max(0, c.num("p90RemainingMs") ?? 0),
            p50TotalMs: max(0, c.num("p50TotalMs") ?? 0),
            p90TotalMs: max(0, c.num("p90TotalMs") ?? 0),
            overrun: c.bool("overrun") ?? false,
            todo: LiveState.Todo(c.obj("todo")),
            toolCalls: c.int("toolCalls") ?? 0,
            waitingSince: c.num("waitingSince"),
            waitingReason: c.str("waitingReason")
        )
    }
}

extension LiveState: Decodable {
    public struct UnsupportedVersion: Error, CustomStringConvertible {
        public let version: Int?
        public var description: String { "unsupported state version \(version.map(String.init) ?? "(missing)"); expected v: 1" }
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        let version = c.int("v")
        guard version == 1 else { throw UnsupportedVersion(version: version) }
        self.init(
            agent: c.str("agent") ?? "agent",
            sessionId: c.str("sessionId") ?? "",
            project: c.str("project"),
            status: c.str("status").flatMap(Status.init(rawValue:)) ?? .idle,
            updatedAt: c.num("updatedAt") ?? 0,
            turn: c.obj("turn").map(Turn.init),
            last: ((try? c.decodeIfPresent(Lossy<Finished>.self, forKey: AnyKey("last"))) ?? nil)?.value,
            history: ((try? c.decodeIfPresent([Lossy<Finished>].self, forKey: AnyKey("history"))) ?? nil)?
                .compactMap(\.value) ?? []
        )
    }

    /// Decode from raw bytes.
    public static func decode(_ data: Data) throws -> LiveState {
        try JSONDecoder().decode(LiveState.self, from: data)
    }
}
