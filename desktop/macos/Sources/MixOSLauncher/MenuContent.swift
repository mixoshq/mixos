// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import SwiftUI

/// The menu bar menu: each copy with its status, and its quick actions.
struct MenuContent: View {
  @EnvironmentObject private var store: Store
  @Environment(\.openWindow) private var openWindow

  var body: some View {
    if store.checkouts.isEmpty {
      Text("No copy of MixOS on this Mac yet")
    }
    ForEach(store.checkouts) { checkout in
      let summary = store.summary(of: checkout)
      let report = store.status(of: checkout).report
      let busy = store.jobs[checkout.id]?.running == true
      Menu("\(summary.symbol)  \(store.title(of: checkout)) — \(summary.text)") {
        if report?.app != nil {
          Button("Open in Browser") { store.open(checkout) }
        }
        Button(report?.app == nil ? "Start" : "Restart") { store.start(checkout) }
          .disabled(busy)
        Button("Stop") { store.stop(checkout) }
          .disabled(busy || report?.app == nil)
        Divider()
        Button("Show Details…") { show(checkout.id) }
        Button("Show in Finder") { store.reveal(checkout) }
      }
    }
    Divider()
    Button("Open MixOS Launcher") { show(nil) }
    Button("Set Up a New Copy…") {
      show(nil)
      store.showingSetup = true
    }
    Button("Refresh") { store.refreshAll() }
    Divider()
    Button("Quit MixOS Launcher") { NSApp.terminate(nil) }
      .keyboardShortcut("q")
  }

  private func show(_ id: String?) {
    if let id { store.selection = id }
    openWindow(id: "main")
    NSApp.activate(ignoringOtherApps: true)
  }
}
