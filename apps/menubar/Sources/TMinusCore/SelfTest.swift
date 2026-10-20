import Foundation

/// Plain-text rendering of exactly what the app would show, for `--selftest`.
public enum SelfTest {
    public static func report(path: String, result: StateFile.LoadResult, now: Double) -> String {
        let state = result.state
        let d = LiveDisplay.compute(state, now: now)
        var out: [String] = []

        out.append("tminus menubar · selftest")
        out.append(kv("file", path))
        switch result {
        case .missing:
            out.append(kv("state", "missing (treated as idle)"))
        case .invalid(let why):
            out.append(kv("state", "invalid (treated as idle): \(why)"))
        case .loaded(let s):
            let age = d.ageMs.map { "updated \(TimeFormat.precise($0)) ago" } ?? ""
            out.append(kv("state", [s.status.rawValue, s.agent, age].filter { !$0.isEmpty }.joined(separator: " · ")))
        }
        out.append("")

        out.append(kv("phase", d.phase.rawValue + (d.isStale ? " (stale: not extrapolating)" : "")))
        out.append(kv("menubar", d.title))
        if let todo = d.todo, d.phase == .running || d.phase == .overrun {
            out.append(kv("ring", "\(todo.done)/\(todo.total)"))
        }
        out.append(kv("tooltip", d.tooltip))
        out.append("")

        out.append("current turn")
        switch d.phase {
        case .running, .overrun, .waiting:
            out.append(kv("project", d.project ?? "—", indent: 2))
            out.append(kv("intent", d.intent ?? "—", indent: 2))
            out.append(kv("elapsed", d.elapsedMs.map(TimeFormat.precise) ?? "—", indent: 2))
            if d.phase == .overrun {
                out.append(kv("status", "running long" + (d.p90TotalMs.map { " · past P90 of \(TimeFormat.short($0))" } ?? ""), indent: 2))
            } else if let c = d.countdownText {
                out.append(kv("remaining", "\(c) · \(d.rangeText ?? "?") (P10–P90)", indent: 2))
            }
            if let p50 = d.p50TotalMs {
                out.append(kv("predicted", "\(TimeFormat.short(p50)) total" + (d.p90TotalMs.map { " · P90 \(TimeFormat.short($0))" } ?? ""), indent: 2))
            }
            if let todo = d.todo {
                out.append(kv("todo", "\(todo.done)/\(todo.total)", indent: 2))
            }
            if d.phase == .waiting {
                let since = d.waitingForMs.map { " for \(TimeFormat.precise($0))" } ?? ""
                out.append(kv("waiting", "on you\(since)" + (d.waitingReason.map { " · \($0)" } ?? ""), indent: 2))
            }
        case .done:
            if let last = d.last {
                out.append(kv("done", "\(last.intent) in \(TimeFormat.precise(last.actualMs))"
                    + (last.p50Ms.map { " · predicted \(TimeFormat.short($0))" } ?? ""), indent: 2))
            }
        case .idle:
            out.append(kv("status", "nothing running", indent: 2))
        }
        out.append("")

        let rows = HistoryRow.rows(from: state?.history ?? [])
        out.append("last 10 turns: predicted vs actual")
        if rows.isEmpty {
            out.append("  (no finished turns yet)")
        } else {
            out.append("  " + col("intent", 14) + col("pred", 7) + col("actual", 8) + "    P10  P50  P90")
            for r in rows {
                let pred = r.p50Ms.map(TimeFormat.short) ?? "–"
                let note = [r.verdict == .unknown ? "" : r.verdict.rawValue, r.isCompleted ? "" : "(\(r.outcome))"]
                    .filter { !$0.isEmpty }.joined(separator: " ")
                let line = "  " + col(r.intent, 14) + col(pred, 7) + col(TimeFormat.precise(r.actualMs), 8)
                    + col(r.textBar(), 23) + note
                out.append(line.replacingOccurrences(of: "\\s+$", with: "", options: .regularExpression))
            }
            if let summary = HistoryRow.calibrationSummary(rows) {
                out.append("  " + summary)
            }
        }
        return out.joined(separator: "\n")
    }

    private static func kv(_ k: String, _ v: String, indent: Int = 0) -> String {
        String(repeating: " ", count: indent) + col(k, indent > 0 ? 11 : 9) + v
    }

    private static func col(_ s: String, _ width: Int) -> String {
        let n = s.count
        return n >= width ? s + " " : s + String(repeating: " ", count: width - n)
    }
}
