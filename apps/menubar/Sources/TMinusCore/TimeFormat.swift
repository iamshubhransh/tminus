import Foundation

/// Duration formatting. Inputs are milliseconds (the unit of the state file).
/// `short` and `range` match the CLI's `fmtShort`/`fmtRange` so the menubar and
/// the statusline never disagree about what "2m" means.
public enum TimeFormat {
    /// Ticking countdown: `2:14`, `0:07`, `1:02:03`. Rounds partial seconds *up*,
    /// so a countdown reads `0:01` until it actually reaches zero.
    public static func clock(_ ms: Double) -> String {
        guard ms.isFinite else { return "–:––" }
        let total = Int((max(0, ms) / 1000).rounded(.up))
        let h = total / 3600, m = (total % 3600) / 60, s = total % 60
        if h > 0 { return "\(h):\(pad(m)):\(pad(s))" }
        return "\(m):\(pad(s))"
    }

    /// Exact-ish: `38s`, `4m12s`, `4m05s`, `1h30m`.
    public static func precise(_ ms: Double) -> String {
        guard ms.isFinite, ms >= 0 else { return "?" }
        let total = Int((ms / 1000).rounded())
        let h = total / 3600, m = (total % 3600) / 60, s = total % 60
        if h > 0 { return "\(h)h\(pad(m))m" }
        if m > 0 { return "\(m)m\(pad(s))s" }
        return "\(s)s"
    }

    /// Glanceable: `40s` (5s steps), `9m`, `1h30m`, `2h`.
    public static func short(_ ms: Double) -> String {
        guard ms.isFinite, ms >= 0 else { return "?" }
        let s = ms / 1000
        if s < 57.5 { return "\(max(5, Int((s / 5).rounded()) * 5))s" }
        let m = Int((s / 60).rounded())
        if m < 60 { return "\(m)m" }
        let h = m / 60, rm = m % 60
        return rm == 0 ? "\(h)h" : "\(h)h\(rm)m"
    }

    /// A range that shares its unit when it can: `1–5m`, `30–45s`, `40s–2m`, `1h–1h40m`.
    public static func range(_ lo: Double, _ hi: Double) -> String {
        let a = short(lo), b = short(hi)
        if a == b { return a }
        for unit in ["m", "s"] where isPlain(a, unit) && isPlain(b, unit) {
            return "\(a.dropLast())–\(b)"
        }
        return "\(a)–\(b)"
    }

    /// `"12m"` is plain minutes; `"1h12m"` is not.
    private static func isPlain(_ s: String, _ unit: String) -> Bool {
        guard s.hasSuffix(unit) else { return false }
        let digits = s.dropLast()
        return !digits.isEmpty && digits.allSatisfy(\.isNumber)
    }

    private static func pad(_ n: Int) -> String { n < 10 ? "0\(n)" : "\(n)" }
}
