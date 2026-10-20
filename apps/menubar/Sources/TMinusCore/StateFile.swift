import Foundation

/// Where the collector writes, and how to read it.
public enum StateFile {
    /// `$TMINUS_HOME`, or `~/.tminus` (same rule as the CLI: an empty value means unset).
    public static func home(environment: [String: String] = ProcessInfo.processInfo.environment) -> URL {
        if let custom = environment["TMINUS_HOME"], !custom.isEmpty {
            return URL(fileURLWithPath: (custom as NSString).expandingTildeInPath, isDirectory: true)
        }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".tminus", isDirectory: true)
    }

    /// `<home>/state` — the directory to watch (the file itself is replaced by rename).
    public static func directory(environment: [String: String] = ProcessInfo.processInfo.environment) -> URL {
        home(environment: environment).appendingPathComponent("state", isDirectory: true)
    }

    /// `<home>/state/current.json`.
    public static func current(environment: [String: String] = ProcessInfo.processInfo.environment) -> URL {
        directory(environment: environment).appendingPathComponent("current.json", isDirectory: false)
    }

    public enum LoadResult: Equatable, Sendable {
        /// No file: nothing has run yet (treated as idle).
        case missing
        /// Present but unreadable or not a v1 state.
        case invalid(String)
        case loaded(LiveState)

        public var state: LiveState? {
            if case .loaded(let s) = self { return s }
            return nil
        }
    }

    public static func load(_ url: URL) -> LoadResult {
        let data: Data
        do {
            data = try Data(contentsOf: url)
        } catch {
            let ns = error as NSError
            if ns.domain == NSCocoaErrorDomain && (ns.code == NSFileReadNoSuchFileError || ns.code == NSFileNoSuchFileError) {
                return .missing
            }
            if !FileManager.default.fileExists(atPath: url.path) { return .missing }
            return .invalid(ns.localizedDescription)
        }
        do {
            return .loaded(try LiveState.decode(data))
        } catch let e as LiveState.UnsupportedVersion {
            return .invalid(e.description)
        } catch {
            return .invalid("not valid JSON: \(error.localizedDescription)")
        }
    }

    /// Cheap identity of the file on disk (inode, size, mtime), used by the
    /// polling fallback to skip re-reading an unchanged file.
    public static func signature(_ url: URL) -> String? {
        var st = stat()
        guard stat(url.path, &st) == 0 else { return nil }
        return "\(st.st_ino):\(st.st_size):\(st.st_mtimespec.tv_sec).\(st.st_mtimespec.tv_nsec)"
    }

    /// Epoch milliseconds, the unit of every timestamp in the state file.
    public static func nowMs() -> Double {
        Date().timeIntervalSince1970 * 1000
    }
}
