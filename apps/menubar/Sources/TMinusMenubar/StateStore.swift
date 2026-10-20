import AppKit
import Foundation
import TMinusCore

/// Owns the state file: watches it, decodes it, and re-derives the display
/// every quarter second so the countdown ticks between collector writes.
@MainActor
final class StateStore: ObservableObject {
    /// Everything the popover shows. Republished only when something visible changes.
    @Published private(set) var display: LiveDisplay
    @Published private(set) var history: [HistoryRow] = []
    /// Set when the file exists but can't be used (the last good state is kept).
    @Published private(set) var problem: String?
    @Published private(set) var fileExists = false

    /// The menubar label lives in its own object so the status item only
    /// re-renders when its text actually changes.
    let label = LabelModel()

    let fileURL: URL
    let directoryURL: URL

    private var state: LiveState?
    private var signature: String?
    private var watcher: DispatchSourceFileSystemObject?
    private var timers: [Timer] = []

    private let debug = ProcessInfo.processInfo.environment["TMINUS_MENUBAR_DEBUG"] != nil

    /// - Parameters:
    ///   - fileURL: the state file; defaults to `$TMINUS_HOME/state/current.json`.
    ///   - live: watch and tick. `false` loads once (used by `--snapshot`).
    init(fileURL: URL = StateFile.current(), live: Bool = true) {
        self.fileURL = fileURL
        directoryURL = fileURL.deletingLastPathComponent()
        display = LiveDisplay.compute(nil, now: StateFile.nowMs())
        reload(force: true, reason: "launch")
        guard live else { return }
        watchDirectory()

        // Display tick: cheap arithmetic; publishes only when a shown second changes.
        schedule(every: 0.25) { $0.tick() }
        // Fallback poll: catches anything the directory watcher misses, and
        // re-arms the watcher if state/ didn't exist yet or was replaced.
        schedule(every: 1.0) { store in
            if store.watcher == nil { store.watchDirectory() }
            store.reload(reason: "poll")
        }
    }

    /// Path shown in the UI, with the home directory abbreviated.
    var displayPath: String {
        (fileURL.path as NSString).abbreviatingWithTildeInPath
    }

    // MARK: - Reading

    func reload(force: Bool = false, reason: String) {
        let sig = StateFile.signature(fileURL)
        guard force || sig != signature else { return }
        signature = sig
        defer { log("reload (\(reason)) → \(display.phase.rawValue) “\(display.title)”") }

        switch StateFile.load(fileURL) {
        case .missing:
            state = nil
            problem = nil
            fileExists = false
        case .invalid(let why):
            // Keep showing the last good state; the next write will replace it.
            problem = why
            fileExists = true
        case .loaded(let s):
            state = s
            problem = nil
            fileExists = true
        }
        let rows = HistoryRow.rows(from: state?.history ?? [])
        if rows != history { history = rows }
        tick()
    }

    func tick() {
        let next = LiveDisplay.compute(state, now: StateFile.nowMs())
        if next != display { display = next }
        label.update(with: next)
    }

    // MARK: - Watching

    /// Watch the *directory*: the collector writes a temp file and renames it
    /// over current.json, which a watcher on the old file descriptor never sees.
    private func watchDirectory() {
        guard watcher == nil else { return }
        let fd = open(directoryURL.path, O_EVTONLY)
        guard fd >= 0 else { return }  // state/ doesn't exist yet; the poll retries

        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd,
            eventMask: [.write, .rename, .delete, .link, .extend, .attrib, .revoke],
            queue: .main
        )
        source.setEventHandler { [weak self] in
            MainActor.assumeIsolated {
                guard let self, let watcher = self.watcher else { return }
                let events = watcher.data
                if !events.isDisjoint(with: [.delete, .rename, .revoke]) {
                    // The directory itself went away or moved: drop it and let the poll re-arm.
                    watcher.cancel()
                    self.watcher = nil
                }
                self.reload(reason: "watch")
            }
        }
        source.setCancelHandler { close(fd) }
        watcher = source
        source.resume()
        log("watching \(directoryURL.path)")
    }

    /// `TMINUS_MENUBAR_DEBUG=1` traces file activity to stderr.
    private func log(_ message: @autoclosure () -> String) {
        guard debug else { return }
        FileHandle.standardError.write(Data("[tminus] \(message())\n".utf8))
    }

    private func schedule(every interval: TimeInterval, _ body: @escaping @MainActor (StateStore) -> Void) {
        let timer = Timer(timeInterval: interval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                body(self)
            }
        }
        timer.tolerance = interval * 0.2
        // .common keeps ticking while a menu or the popover is tracking events.
        RunLoop.main.add(timer, forMode: .common)
        timers.append(timer)
    }
}
