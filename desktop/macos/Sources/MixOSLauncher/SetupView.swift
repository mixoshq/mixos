// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import LauncherCore
import SwiftUI

/// Setting up a new copy: what the Mac needs, where the copy goes, then the
/// steps, with their output, until MixOS answers.
struct SetupView: View {
  @StateObject private var setup: Setup
  @Environment(\.dismiss) private var dismiss

  init(store: Store) {
    _setup = StateObject(wrappedValue: Setup(store: store))
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      HStack(spacing: 12) {
        LogoView(height: 36)
        Text("Set Up a New Copy of MixOS").font(.title).bold()
      }

      switch setup.phase {
      case .prerequisites:
        prerequisites
      case .running, .failed:
        progress
      case .done(let url):
        done(url)
      }
    }
    .padding(24)
    .frame(width: 640)
    .frame(minHeight: 460)
    .onAppear { setup.checkPrerequisites() }
  }

  // ── What the Mac needs, and where ─────────────────────────────────────────

  private var prerequisites: some View {
    VStack(alignment: .leading, spacing: 18) {
      GroupBox("What this Mac needs") {
        VStack(alignment: .leading, spacing: 12) {
          NeedRow(name: "git", need: setup.git) {
            Button("Install Developer Tools") { setup.installDeveloperTools() }
          }
          NeedRow(name: "Node", need: setup.node) {
            if setup.hasHomebrew { Button("Install with Homebrew") { setup.installNodeWithHomebrew() } }
            Button("Download Node") { setup.openDownload("https://nodejs.org/en/download") }
          }
          NeedRow(name: "Docker", need: setup.docker) {
            if setup.dockerInstalledNotRunning {
              Button("Start Docker") { setup.startDocker() }
            } else {
              Button("Download Docker Desktop") {
                setup.openDownload("https://www.docker.com/products/docker-desktop/")
              }
            }
          }
          HStack {
            Spacer()
            Button("Check Again") { setup.checkPrerequisites() }
          }
        }
        .padding(6)
      }

      GroupBox("Where it goes") {
        VStack(alignment: .leading, spacing: 8) {
          HStack {
            Text(setup.parent.path).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
            Text("/")
            TextField("Folder name", text: $setup.folderName).frame(width: 160)
            Spacer()
            Button("Choose…") { chooseParent() }
          }
          if let problem = setup.destinationProblem {
            Text(problem).font(.caption).foregroundStyle(.red)
          } else {
            Text("It gets its own database, separate from any other copy on this Mac.")
              .font(.caption).foregroundStyle(.secondary)
          }
        }
        .padding(6)
      }

      if !setup.log.isEmpty { LogText(lines: setup.log) }

      Spacer(minLength: 0)
      HStack {
        Button("Cancel") { dismiss() }
        Spacer()
        Button("Set Up MixOS") { setup.begin() }
          .buttonStyle(.borderedProminent)
          .keyboardShortcut(.defaultAction)
          .disabled(!setup.ready || setup.destinationProblem != nil)
      }
    }
  }

  private func chooseParent() {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.canCreateDirectories = true
    panel.prompt = "Choose"
    panel.message = "Choose the folder to put the new copy of MixOS in."
    panel.directoryURL = setup.parent
    if panel.runModal() == .OK, let url = panel.url {
      setup.parent = url
      setup.folderName = CheckoutFolder.suggestedNew(in: url).lastPathComponent
    }
  }

  // ── The steps ─────────────────────────────────────────────────────────────

  private var progress: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text(setup.destination.path).foregroundStyle(.secondary)
      VStack(alignment: .leading, spacing: 8) {
        ForEach(setup.steps) { step in
          HStack(spacing: 10) {
            Group {
              switch step.state {
              case .waiting: Image(systemName: "circle").foregroundStyle(.secondary)
              case .running: ProgressView().controlSize(.small)
              case .done: Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
              case .failed: Image(systemName: "xmark.circle.fill").foregroundStyle(.red)
              }
            }
            .frame(width: 18)
            Text(step.title)
          }
        }
      }
      if case .failed(let why) = setup.phase {
        if let port = setup.suggestedPort {
          Notice(
            symbol: "arrow.right.circle.fill",
            color: .blue,
            text: "Another MixOS is using the port this copy wanted. Port \(port) is free.",
            action: ("Start on Port \(port)", { setup.begin(port: port) })
          )
        } else {
          Notice(symbol: "xmark.octagon.fill", color: .red, text: why)
        }
      }
      LogText(lines: setup.log)
      Spacer(minLength: 0)
      HStack {
        if case .failed = setup.phase {
          Button("Close") { dismiss() }
          Spacer()
          Button("Try Again") { setup.begin() }.buttonStyle(.borderedProminent)
        } else {
          Button("Cancel") { setup.cancel() }
          Spacer()
        }
      }
    }
  }

  // ── Done ──────────────────────────────────────────────────────────────────

  private func done(_ url: URL) -> some View {
    VStack(alignment: .leading, spacing: 14) {
      Notice(symbol: "checkmark.seal.fill", color: .green, text: "MixOS is set up in \(url.path).")
      if let report = setup.report {
        ChecksView(report: report)
      }
      Spacer(minLength: 0)
      HStack {
        Spacer()
        if let app = setup.report?.app, let link = URL(string: app.url) {
          Button("Open in Browser") { NSWorkspace.shared.open(link) }
        }
        Button("Done") {
          setup.store.selection = url.standardizedFileURL.path
          dismiss()
        }
        .buttonStyle(.borderedProminent)
        .keyboardShortcut(.defaultAction)
      }
    }
  }
}

private struct NeedRow<Actions: View>: View {
  let name: String
  let need: Setup.Need
  @ViewBuilder let actions: () -> Actions

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      Group {
        switch need {
        case .checking: ProgressView().controlSize(.small)
        case .ok: Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
        case .missing: Image(systemName: "xmark.circle.fill").foregroundStyle(.red)
        }
      }
      .frame(width: 18)
      Text(name).frame(width: 60, alignment: .leading)
      switch need {
      case .checking: Text("Checking…").foregroundStyle(.secondary)
      case .ok(let detail): Text(detail).foregroundStyle(.secondary)
      case .missing(let detail): Text(detail)
      }
      Spacer()
      if case .missing = need { actions() }
    }
  }
}
