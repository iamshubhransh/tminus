import Testing
@testable import TMinusCore

@Suite("Duration formatting")
struct TimeFormatTests {
    @Test(arguments: [
        (134_000.0, "2:14"),
        (7_000, "0:07"),
        (0, "0:00"),
        (59_001, "1:00"),  // partial seconds round up: a countdown shows 0:01, not 0:00
        (600_000, "10:00"),
        (3_723_000, "1:02:03"),
    ])
    func clock(ms: Double, expected: String) {
        #expect(TimeFormat.clock(ms) == expected)
    }

    @Test(arguments: [
        (252_000.0, "4m12s"),
        (245_000, "4m05s"),
        (38_000, "38s"),
        (5_400_000, "1h30m"),
        (3_780_000, "1h03m"),
    ])
    func precise(ms: Double, expected: String) {
        #expect(TimeFormat.precise(ms) == expected)
    }

    @Test(arguments: [
        (540_000.0, "9m"),
        (5_400_000, "1h30m"),
        (7_200_000, "2h"),
        (40_000, "40s"),
        (1_000, "5s"),
        (58_000, "1m"),
        (3_590_000, "1h"),
    ])
    func short(ms: Double, expected: String) {
        #expect(TimeFormat.short(ms) == expected)
    }

    @Test func range() {
        #expect(TimeFormat.range(60_000, 300_000) == "1–5m")
        #expect(TimeFormat.range(30_000, 45_000) == "30–45s")
        #expect(TimeFormat.range(40_000, 120_000) == "40s–2m")
        #expect(TimeFormat.range(3_600_000, 6_000_000) == "1h–1h40m")
        #expect(TimeFormat.range(120_000, 120_000) == "2m")
    }
}
