// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import LauncherCore
import SwiftUI

/// The window: every copy of MixOS on this Mac down the side, the selected
/// one's status, actions and output on the right.
///
/// A fixed-width column and a divider, not NavigationSplitView. That one
/// sizes itself from the split view frames AppKit saves between launches, and
/// a saved height of 3,268 points, in a window 548 high, put the sidebar's
/// rows and every button above the top of the window: a window that looked
/// empty while its list was full. Nothing here is saved, so nothing can be
/// restored wrong.
struct MainWindow: View {
  @EnvironmentObject private var store: Store

  var body: some View {
    HStack(spacing: 0) {
      List(selection: $store.selection) {
        Section("MixOS on this Mac") {
          ForEach(store.checkouts) { checkout in
            CheckoutRow(checkout: checkout).tag(checkout.id)
          }
          if store.checkouts.isEmpty {
            Text("Looking for copies of MixOS…").foregroundStyle(.secondary)
          }
        }
      }
      .listStyle(.sidebar)
      .frame(width: 250)

      Divider()

      Group {
        if let checkout = store.checkouts.first(where: { $0.id == store.selection }) {
          // Scrolls, rather than clips, in a window too short for a long log.
          ScrollView { CheckoutDetail(checkout: checkout) }
        } else {
          Welcome()
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    .toolbar {
      ToolbarItem {
        Menu {
          Button("Set Up a New Copy…") { store.showingSetup = true }
          Button("Add an Existing Copy…") { AddCheckout.choose(store) }
        } label: {
          Label("Add", systemImage: "plus")
        }
      }
    }
    .sheet(isPresented: $store.showingSetup) {
      SetupView(store: store)
    }
  }
}

private struct CheckoutRow: View {
  @EnvironmentObject private var store: Store
  let checkout: Checkout

  var body: some View {
    let summary = store.summary(of: checkout)
    HStack(spacing: 8) {
      Circle().fill(summary.color).frame(width: 9, height: 9)
      VStack(alignment: .leading, spacing: 2) {
        Text(store.title(of: checkout)).font(.body)
        Text(summary.text).font(.caption).foregroundStyle(.secondary)
      }
    }
    .padding(.vertical, 2)
    .contextMenu {
      Button("Show in Finder") { store.reveal(checkout) }
      Button("Remove from List") { store.remove(checkout) }
    }
  }
}

/// No copies yet, or none selected: the two ways to get one.
private struct Welcome: View {
  @EnvironmentObject private var store: Store

  var body: some View {
    VStack(spacing: 14) {
      LogoView(height: 88)
      Text(store.checkouts.isEmpty ? "No copy of MixOS on this Mac yet" : "Choose a copy of MixOS")
        .font(.title2)
      Text("Each copy has its own database, its own containers and its own address.")
        .foregroundStyle(.secondary)
      HStack {
        Button("Set Up a New Copy…") { store.showingSetup = true }
          .buttonStyle(.borderedProminent)
        Button("Add an Existing Copy…") { AddCheckout.choose(store) }
      }
    }
    .padding(40)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

struct CheckoutDetail: View {
  @EnvironmentObject private var store: Store
  let checkout: Checkout

  var body: some View {
    let status = store.status(of: checkout)
    let report = status.report
    let job = store.jobs[checkout.id]
    let busy = job?.running == true

    VStack(alignment: .leading, spacing: 16) {
      VStack(alignment: .leading, spacing: 4) {
        Text(store.title(of: checkout)).font(.largeTitle).bold()
        Button(checkout.url.path) { store.reveal(checkout) }
          .buttonStyle(.link)
          .foregroundStyle(.secondary)
      }

      HStack {
        Button {
          store.start(checkout)
        } label: {
          Label(store.isRunning(checkout) ? "Restart" : "Start", systemImage: "play.fill")
        }
        .buttonStyle(.borderedProminent)
        .disabled(busy)
        Button {
          store.stop(checkout)
        } label: {
          Label("Stop", systemImage: "stop.fill")
        }
        .disabled(busy || !store.hasAnythingRunning(checkout))
        Button {
          store.open(checkout)
        } label: {
          Label("Open in Browser", systemImage: "safari")
        }
        .disabled(store.appURL(of: checkout) == nil)
        Spacer()
        if store.refreshing.contains(checkout.id) { ProgressView().controlSize(.small) }
        Button {
          store.refresh(checkout)
        } label: {
          Image(systemName: "arrow.clockwise")
        }
        .help("Check again")
        .disabled(busy)
        Menu {
          Button("Show in Finder") { store.reveal(checkout) }
          Button("Open in Terminal") { store.openInTerminal(checkout) }
          Divider()
          Button("Remove from List") { store.remove(checkout) }
        } label: {
          Image(systemName: "ellipsis.circle")
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
      }

      if let owner = report?.sharedWith {
        Notice(
          symbol: "exclamationmark.triangle.fill",
          color: .orange,
          text: "This copy has no database of its own yet: `\(report?.instance ?? "")` belongs to \(owner). " +
            "Start gives it an instance and a fresh database of its own."
        )
      }

      if let copy = store.detected[checkout.id], report == nil || report?.app == nil, copy.running {
        Notice(
          symbol: copy.app == nil ? "cylinder.split.1x2" : "dot.radiowaves.left.and.right",
          color: copy.app == nil ? .blue : .green,
          text: copy.app.map { "Running \($0.how) at \($0.url). Its checks are on their way." }
            ?? "Its database is running, but its app isn't. Start runs both; Stop stops both."
        )
      }

      switch status {
      case .unknown:
        HStack { ProgressView().controlSize(.small); Text("Asking this copy how it is…").foregroundStyle(.secondary) }
      case .unavailable(let why):
        Notice(symbol: "questionmark.circle", color: .secondary, text: why)
      case .report(let report):
        ChecksView(report: report)
      }

      if let job {
        JobView(job: job, retry: { port in store.start(checkout, port: port) })
      }

      Spacer(minLength: 0)
    }
    .padding(24)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
  }
}

/// The checkout's own answer: a line per check, each failure with its fix.
struct ChecksView: View {
  let report: StatusReport

  var body: some View {
    GroupBox {
      VStack(alignment: .leading, spacing: 10) {
        Text(report.headline).font(.headline)
        ForEach(report.checks) { check in
          HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: icon(check.state))
              .foregroundStyle(color(check.state))
              .frame(width: 16)
            Text(check.name).frame(width: 90, alignment: .leading).foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 2) {
              ForEach(Array(check.lines.enumerated()), id: \.offset) { _, line in
                Text(line).textSelection(.enabled)
              }
              if check.state == .fail, let fix = check.fix {
                Text("→ \(fix)").foregroundStyle(.orange).textSelection(.enabled)
              }
            }
          }
        }
        if let how = report.app?.how {
          Text("Running \(how).").font(.caption).foregroundStyle(.secondary)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(6)
    }
  }

  private func icon(_ state: StatusReport.State) -> String {
    switch state {
    case .ok: return "checkmark.circle.fill"
    case .fail: return "xmark.circle.fill"
    case .skip: return "minus.circle"
    }
  }

  private func color(_ state: StatusReport.State) -> Color {
    switch state {
    case .ok: return .green
    case .fail: return .red
    case .skip: return .secondary
    }
  }
}

/// A running or finished command's output, scrolled to the end as it grows.
struct JobView: View {
  @ObservedObject var job: Job
  var retry: ((Int) -> Void)?

  var body: some View {
    GroupBox {
      VStack(alignment: .leading, spacing: 8) {
        HStack {
          if job.running { ProgressView().controlSize(.small) }
          Text(job.running ? job.title + "…" : job.title).font(.headline)
          Spacer()
          if job.running {
            Button("Cancel") { job.cancel() }
          } else if let status = job.status {
            Text(status == 0 ? "Done" : "Failed (exit \(status))")
              .foregroundStyle(status == 0 ? Color.green : Color.red)
          }
        }
        if let port = job.suggestedPort, !job.running, let retry {
          Notice(
            symbol: "arrow.right.circle.fill",
            color: .blue,
            text: "Another MixOS is using this copy's port. Port \(port) is free.",
            action: ("Start on Port \(port)", { retry(port) })
          )
        }
        LogText(lines: job.lines)
      }
      .padding(6)
    }
  }
}

struct LogText: View {
  let lines: [String]

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView {
        Text(lines.joined(separator: "\n"))
          .font(.system(.caption, design: .monospaced))
          .textSelection(.enabled)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(6)
        Color.clear.frame(height: 1).id("end")
      }
      .frame(minHeight: 140, maxHeight: 260)
      .background(Color(nsColor: .textBackgroundColor))
      .clipShape(RoundedRectangle(cornerRadius: 6))
      .onChange(of: lines.count) { _ in proxy.scrollTo("end", anchor: .bottom) }
    }
  }
}

struct Notice: View {
  let symbol: String
  let color: Color
  let text: String
  var action: (String, () -> Void)?

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      Image(systemName: symbol).foregroundStyle(color)
      Text(.init(text)).fixedSize(horizontal: false, vertical: true)
      Spacer()
      if let action { Button(action.0, action: action.1) }
    }
    .padding(10)
    .background(color.opacity(0.1))
    .clipShape(RoundedRectangle(cornerRadius: 8))
  }
}
