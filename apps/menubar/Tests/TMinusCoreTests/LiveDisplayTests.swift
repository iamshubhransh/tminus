import Testing
@testable import TMinusCore

@Suite("Countdown, overrun and done-linger at a fixed now")
struct LiveDisplayTests {
    static let t0: Double = 1_760_961_600_000

    static func running(
        status: LiveState.Status = .running, elapsed: Double = 252_000, p50: Double = 134_000,
        p90Total: Double = 660_000, todo: LiveState.Todo? = .init(done: 3, total: 7)
    ) -> LiveState {
        LiveState(
            agent: "claude-code", sessionId: "s", project: "tminus", status: status, updatedAt: t0,
            turn: .init(
                submittedAt: t0 - elapsed, elapsedMs: elapsed, intent: "fix",
                p10RemainingMs: 60_000, p50RemainingMs: p50, p90RemainingMs: 300_000,
                p50TotalMs: 360_000, p90TotalMs: p90Total, todo: todo, toolCalls: 23,
                waitingSince: status == .waiting ? t0 - 20_000 : nil,
                waitingReason: status == .waiting ? "AskUserQuestion" : nil
            )
        )
    }

    @Test func freshStateShowsP50() {
        let d = LiveDisplay.compute(Self.running(), now: Self.t0)
        #expect(d.phase == .running)
        #expect(d.title == "⏳ 2:14")
        #expect(d.tooltip == "1–5m remaining (P10–P90)")
        #expect(d.todo == .init(done: 3, total: 7))
        #expect(d.elapsedMs == 252_000)
    }

    @Test func countsDownLocallyBetweenWrites() {
        let d = LiveDisplay.compute(Self.running(), now: Self.t0 + 4_000)
        #expect(d.title == "⏳ 2:10")
        #expect(d.elapsedMs == 256_000)
        #expect(d.isStale == false)
    }

    @Test func neverCountsBelowOneSecond() {
        let d = LiveDisplay.compute(Self.running(p50: 3_000), now: Self.t0 + 20_000)
        #expect(d.title == "⏳ 0:01")
    }

    @Test func staleStateIsFrozenNotExtrapolated() {
        let d = LiveDisplay.compute(Self.running(), now: Self.t0 + 45_000)
        #expect(d.isStale)
        #expect(d.title == "⏳ 2:14")
        #expect(d.elapsedMs == 252_000)
        #expect(d.tooltip.contains("no update"))
    }

    @Test func overrunWhenExtrapolatedElapsedPassesP90() {
        // 9m elapsed vs a P90 total of 9m05s: not yet...
        let state = Self.running(elapsed: 540_000, p90Total: 545_000)
        #expect(LiveDisplay.compute(state, now: Self.t0).phase == .running)
        // ...but 10s later (still fresh) the local clock crosses it.
        let later = LiveDisplay.compute(state, now: Self.t0 + 10_000)
        #expect(later.phase == .overrun)
        #expect(later.title == "running long 9m")
    }

    @Test func overrunFlagFromCollectorIsHonoured() {
        var state = Self.running(elapsed: 100_000)
        state.turn?.overrun = true
        #expect(LiveDisplay.compute(state, now: Self.t0).phase == .overrun)
    }

    @Test func waitingDoesNotTick() {
        let state = Self.running(status: .waiting)
        let d = LiveDisplay.compute(state, now: Self.t0 + 5_000)
        #expect(d.phase == .waiting)
        #expect(d.title == "⏸")
        #expect(d.elapsedMs == 252_000)  // waiting time isn't active time
        #expect(d.waitingForMs == 25_000)
        #expect(d.tooltip == "Waiting on you · AskUserQuestion")
    }

    @Test func doneLingersTenSecondsForCompletedTurns() {
        let finished = LiveState.Finished(finishedAt: Self.t0, actualMs: 252_000, p50Ms: 180_000, p90Ms: 360_000, outcome: "completed", intent: "fix")
        let state = LiveState(status: .done, updatedAt: Self.t0, last: finished, history: [finished])

        let soon = LiveDisplay.compute(state, now: Self.t0 + 3_000)
        #expect(soon.phase == .done)
        #expect(soon.title == "✓ 4m12s")
        #expect(soon.tooltip == "Done in 4m12s · predicted 3m")

        #expect(LiveDisplay.compute(state, now: Self.t0 + 10_000).phase == .done)
        let after = LiveDisplay.compute(state, now: Self.t0 + 10_001)
        #expect(after.phase == .idle)
        #expect(after.title == LiveDisplay.idleTitle)
    }

    @Test func interruptedTurnsDontCelebrate() {
        let finished = LiveState.Finished(finishedAt: Self.t0, actualMs: 30_000, p50Ms: nil, p90Ms: nil, outcome: "interrupted", intent: "fix")
        let state = LiveState(status: .done, updatedAt: Self.t0, last: finished)
        #expect(LiveDisplay.compute(state, now: Self.t0 + 1_000).phase == .idle)
    }

    @Test func runningTakesPrecedenceOverRecentDone() {
        var state = Self.running()
        state.last = .init(finishedAt: Self.t0 - 1_000, actualMs: 1_000, p50Ms: nil, p90Ms: nil, outcome: "completed", intent: "fix")
        #expect(LiveDisplay.compute(state, now: Self.t0).phase == .running)
    }

    @Test func noStateIsIdle() {
        let d = LiveDisplay.compute(nil, now: Self.t0)
        #expect(d.phase == .idle)
        #expect(d.title == "T–")
    }

    @Test func historyPlacement() {
        func row(_ actual: Double) -> HistoryRow {
            HistoryRow(id: 0, .init(finishedAt: 0, actualMs: actual, p50Ms: 120_000, p90Ms: 480_000, outcome: "completed", intent: "fix"))
        }
        // p10 mirrors p90 around p50 in log space: 120² / 480 = 30s.
        #expect(row(120_000).p10Ms == 30_000)
        #expect(row(120_000).position == 0.5)
        #expect(row(120_000).verdict == .within)
        #expect(row(480_000).position == 0.75)
        #expect(row(30_000).position == 0.25)
        #expect(row(600_000).verdict == .over)
        #expect(row(20_000).verdict == .under)
        #expect(row(10_000_000).clamped)
        #expect(row(10_000_000).position == 1)
        #expect(row(120_000).textBar() == "·····[────●────]·····")

        let noPrediction = HistoryRow(id: 1, .init(finishedAt: 0, actualMs: 5_000, p50Ms: nil, p90Ms: nil, outcome: "completed", intent: "fix"))
        #expect(noPrediction.verdict == .unknown)
        #expect(noPrediction.position == nil)
        #expect(HistoryRow.calibrationSummary([row(120_000), row(600_000), noPrediction]) == "1 of 2 within P10–P90")
    }
}
