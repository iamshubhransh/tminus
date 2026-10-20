import AppKit
import SwiftUI
import TMinusCore

struct TMinusApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var store = StateStore()

    var body: some Scene {
        MenuBarExtra {
            PopoverView(store: store)
        } label: {
            MenuBarLabel(label: store.label)
        }
        .menuBarExtraStyle(.window)
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationWillFinishLaunching(_ notification: Notification) {
        // A menubar app: no Dock icon, no app menu. (The bundle also sets LSUIElement.)
        NSApp.setActivationPolicy(.accessory)
    }
}
