import Foundation
import Testing
@testable import TMinusCore

@Suite("Decoding the collector's state file")
struct DecodingTests {
    static let full = """
    {
      "v": 1,
      "agent": "claude-code",
      "sessionId": "abc-123",
      "project": "tminus",
      "status": "running",
      "updatedAt": 1760961600000,
      "someFutureField": {"nested": [1, 2, 3]},
      "turn": {
        "submittedAt": 1760961348000,
        "elapsedMs": 252000,
        "idleMs": 1500,
        "intent": "fix",
        "p10RemainingMs": 60000,
        "p50RemainingMs": 134000.75,
        "p90RemainingMs": 300000,
        "p50TotalMs": 360000,
        "p90TotalMs": 660000,
        "overrun": false,
        "todo": {"done": 3, "total": 7},
        "toolCalls": 23,
        "waitingSince": null,
        "waitingReason": null,
        "weights": {"prior": 0.4, "todo": 0.5, "activity": 0.1},
        "bucket": {"level": "intent", "n": 42}
      },
      "last": {"finishedAt": 1760961000000, "actualMs": 252000, "p50Ms": 180000, "p90Ms": 360000, "outcome": "completed", "intent": "explain"},
      "history": [
        {"finishedAt": 1760961000000, "actualMs": 252000, "p50Ms": 180000, "p90Ms": 360000, "intent": "explain", "outcome": "completed"},
        {"finishedAt": 1760960000000, "actualMs": 40000, "p50Ms": null, "p90Ms": null, "intent": "question", "outcome": "interrupted"}
      ]
    }
    """

    @Test func decodesTheDocumentedShape() throws {
        let s = try LiveState.decode(Data(Self.full.utf8))
        #expect(s.v == 1)
        #expect(s.agent == "claude-code")
        #expect(s.sessionId == "abc-123")
        #expect(s.project == "tminus")
        #expect(s.status == .running)
        #expect(s.updatedAt == 1_760_961_600_000)

        let t = try #require(s.turn)
        #expect(t.intent == "fix")
        #expect(t.elapsedMs == 252_000)
        #expect(t.p50RemainingMs == 134_000.75)
        #expect(t.p90TotalMs == 660_000)
        #expect(t.todo == LiveState.Todo(done: 3, total: 7))
        #expect(t.toolCalls == 23)
        #expect(t.waitingSince == nil)

        #expect(s.last?.intent == "explain")
        #expect(s.last?.isCompleted == true)
        #expect(s.history.count == 2)
        #expect(s.history[1].p50Ms == nil)
        #expect(s.history[1].outcome == "interrupted")
    }

    @Test func nullTurnAndLastAreIdle() throws {
        let json = #"{"v":1,"agent":"codex","sessionId":"s","project":null,"status":"idle","updatedAt":5,"turn":null,"last":null,"history":[]}"#
        let s = try LiveState.decode(Data(json.utf8))
        #expect(s.turn == nil)
        #expect(s.last == nil)
        #expect(s.project == nil)
        #expect(s.history.isEmpty)
        #expect(LiveDisplay.compute(s, now: 10).phase == .idle)
    }

    @Test func toleratesMissingAndMistypedFields() throws {
        // Missing history, a status we don't know, a string number, a junk history entry.
        let json = """
        {"v":1,"status":"thinking","updatedAt":"1000",
         "turn":{"elapsedMs":"oops","p50RemainingMs":5000,"todo":{"done":1}},
         "history":[{"finishedAt":1,"actualMs":2000,"p50Ms":1000,"p90Ms":3000,"intent":"fix","outcome":"completed"}, 42, {"intent":"no times"}]}
        """
        let s = try LiveState.decode(Data(json.utf8))
        #expect(s.status == .idle)
        #expect(s.updatedAt == 1000)
        #expect(s.turn?.elapsedMs == 0)
        #expect(s.turn?.p50RemainingMs == 5000)
        #expect(s.turn?.todo == nil)  // no total: no ring
        #expect(s.history.count == 1)
    }

    @Test func rejectsOtherVersions() {
        #expect(throws: LiveState.UnsupportedVersion.self) {
            try LiveState.decode(Data(#"{"v":2,"status":"running"}"#.utf8))
        }
        #expect(throws: (any Error).self) {
            try LiveState.decode(Data("not json".utf8))
        }
    }

    @Test func missingFileIsMissingNotAnError() {
        let url = URL(fileURLWithPath: "/nonexistent-\(UUID().uuidString)/state/current.json")
        #expect(StateFile.load(url) == .missing)
        #expect(LiveDisplay.compute(StateFile.load(url).state, now: 0).title == LiveDisplay.idleTitle)
    }

    @Test func homeHonoursTminusHome() {
        #expect(StateFile.current(environment: ["TMINUS_HOME": "/tmp/tm"]).path == "/tmp/tm/state/current.json")
        #expect(StateFile.current(environment: ["TMINUS_HOME": ""]).path.hasSuffix("/.tminus/state/current.json"))
        #expect(StateFile.current(environment: [:]).path.hasSuffix("/.tminus/state/current.json"))
    }
}
