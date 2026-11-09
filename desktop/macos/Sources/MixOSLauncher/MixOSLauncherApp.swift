// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import LauncherCore
import SwiftUI

/// MixOS Launcher: a window that lists every MixOS on this Mac with its
/// status, and a menu bar icon for the quick things — open, start, stop —
/// without the window. Closing the window leaves the menu bar icon running.
@main
struct MixOSLauncherApp: App {
  @StateObject private var store = Store()

  var body: some Scene {
    Window("MixOS Launcher", id: "main") {
      MainWindow()
        .environmentObject(store)
        .frame(minWidth: 760, minHeight: 480)
        .background(FollowsYouAcrossSpaces())
    }
    .defaultSize(width: 920, height: 600)
    .commands {
      CommandGroup(after: .newItem) {
        Button("Set Up a New Copy…") { store.showingSetup = true }
          .keyboardShortcut("n")
        Button("Add an Existing Copy…") { AddCheckout.choose(store) }
          .keyboardShortcut("o")
      }
      CommandGroup(after: .toolbar) {
        Button("Refresh") { store.refreshAll() }
          .keyboardShortcut("r")
      }
    }

    MenuBarExtra {
      MenuContent()
        .environmentObject(store)
    } label: {
      MenuBarLabel(state: store.menuBarState)
    }

    Settings {
      Form {
        Toggle("Open MixOS in the browser when it starts", isOn: store.$openBrowserOnStart)
      }
      .padding(20)
      .frame(width: 420)
    }
  }
}

/// Choosing a folder that is already a MixOS checkout.
@MainActor
enum AddCheckout {
  static func choose(_ store: Store) {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.allowsMultipleSelection = false
    panel.prompt = "Add"
    panel.message = "Choose the folder of a MixOS copy: the one with docker-compose.yml and scripts/ in it."
    guard panel.runModal() == .OK, let url = panel.url else { return }
    if CheckoutFolder.isMixOS(url) {
      store.add(url)
    } else {
      let alert = NSAlert()
      alert.messageText = "That folder isn't a copy of MixOS"
      alert.informativeText =
        "\(url.path) has no docker-compose.yml and scripts/instance.ts. Choose the folder you cloned MixOS into, or set up a new copy."
      alert.runModal()
    }
  }
}

/// The menu bar icon: the MixOS mark, full while some copy is up and dimmed
/// while none is; a warning sign when a running copy fails a check, which is
/// the one state worth catching the eye.
private struct MenuBarLabel: View {
  let state: Store.MenuBarState

  var body: some View {
    if state == .attention {
      Image(systemName: "exclamationmark.triangle")
    } else if let image = Brand.menuBarImage(alpha: state == .up ? 1 : 0.45) {
      Image(nsImage: image)
    } else {
      Image(systemName: state == .up ? "square.grid.3x3.fill" : "square.grid.3x3")
    }
  }
}

/// The window opens where the person is. By default a macOS window belongs to
/// the Space it was first shown on, so opening the launcher from the menu bar
/// while in another Space — or over an app in full screen, VS Code say — sent
/// them to that Space, and the window seemed to vanish the moment they went
/// back. A launcher is a glance, so its window moves to the active Space
/// instead, and may sit over a full-screen app.
private struct FollowsYouAcrossSpaces: NSViewRepresentable {
  func makeNSView(context: Context) -> NSView {
    let view = NSView()
    DispatchQueue.main.async { configure(view.window) }
    return view
  }

  func updateNSView(_ view: NSView, context: Context) {
    DispatchQueue.main.async { configure(view.window) }
  }

  private func configure(_ window: NSWindow?) {
    window?.collectionBehavior.formUnion([.moveToActiveSpace, .fullScreenAuxiliary])
  }
}
