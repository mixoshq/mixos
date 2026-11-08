// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import LauncherCore
import SwiftUI

/// A MixOS checkout on this Mac: a folder, known by its path.
struct Checkout: Identifiable, Hashable {
  let url: URL
  var id: String { url.path }
  var folderName: String { url.lastPathComponent }
}

/// What the launcher knows about a checkout's status right now.
enum Status: Equatable {
  case unknown
  case report(StatusReport)
  /// The checkout couldn't answer `npm run status -- --json`: usually a copy
  /// from before that command existed.
  case unavailable(String)

  var report: StatusReport? {
    if case .report(let report) = self { return report }
    return nil
  }
}

/// A command running for a checkout, with its output so far. Updated on the
/// main queue only, in the order the output arrived.
final class Job: ObservableObject {
  let title: String
  @Published var lines: [String] = []
  @Published var running = true
  @Published var status: Int32?
  /// The port a failed boot recommended, offered as a button.
  @Published var suggestedPort: Int?
  var process: Process?

  init(title: String) {
    self.title = title
  }

  func cancel() {
    process?.terminate()
  }
}

/// Everything the window and the menu bar show, and every action they take.
///
/// The launcher decides nothing about MixOS itself. It asks each checkout with
/// `npm run status -- --json`, starts one with `npm run dev:docker -- --detach`
/// and stops one with `npm run docker:down`, so what it shows is always what
/// that checkout's own code says.
@MainActor
final class Store: ObservableObject {
  @Published private(set) var checkouts: [Checkout] = []
  @Published private(set) var statuses: [String: Status] = [:]
  @Published private(set) var jobs: [String: Job] = [:]
  @Published var selection: String?
  @Published var showingSetup = false
  @Published private(set) var refreshing: Set<String> = []

  @AppStorage("openBrowserOnStart") var openBrowserOnStart = true

  private(set) var runner: CommandRunner?
  private var timer: Timer?

  private static let addedKey = "addedCheckouts"
  private static let discoveredKey = "discoveredCheckouts"
  private static let hiddenKey = "hiddenCheckouts"

  /// How often status is asked again. Each ask starts Node in each checkout,
  /// so not often; an action refreshes its checkout straight away anyway.
  private static let refreshInterval: TimeInterval = 20

  init() {
    loadCheckouts()
    Task {
      runner = CommandRunner(path: await LoginShell.resolvePath())
      refreshAll()
    }
    timer = Timer.scheduledTimer(withTimeInterval: Self.refreshInterval, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.refreshAll() }
    }
  }

  // ── The list ──────────────────────────────────────────────────────────────

  /// Checkouts this launcher was given, plus every one that has booted MixOS
  /// (their claims) or been seen running by another's status report, minus
  /// those the person removed from the list.
  func loadCheckouts() {
    let defaults = UserDefaults.standard
    let added = defaults.stringArray(forKey: Self.addedKey) ?? []
    let discovered = defaults.stringArray(forKey: Self.discoveredKey) ?? []
    let hidden = Set(defaults.stringArray(forKey: Self.hiddenKey) ?? [])
    let claimed = Claims.read().values.map(\.checkout)
    var seen = Set<String>()
    var found: [Checkout] = []
    for path in added + claimed.sorted() + discovered where !hidden.contains(path) && seen.insert(path).inserted {
      let url = URL(fileURLWithPath: path)
      if CheckoutFolder.isMixOS(url) { found.append(Checkout(url: url)) }
    }
    checkouts = found
    if selection == nil { selection = found.first?.id }
  }

  func add(_ url: URL) {
    let path = url.standardizedFileURL.path
    let defaults = UserDefaults.standard
    var added = defaults.stringArray(forKey: Self.addedKey) ?? []
    if !added.contains(path) { added.append(path) }
    defaults.set(added, forKey: Self.addedKey)
    defaults.set((defaults.stringArray(forKey: Self.hiddenKey) ?? []).filter { $0 != path }, forKey: Self.hiddenKey)
    loadCheckouts()
    selection = path
    refresh(Checkout(url: URL(fileURLWithPath: path)))
  }

  /// Off the list only. The folder and its MixOS are left exactly as they are.
  func remove(_ checkout: Checkout) {
    let defaults = UserDefaults.standard
    defaults.set((defaults.stringArray(forKey: Self.addedKey) ?? []).filter { $0 != checkout.id }, forKey: Self.addedKey)
    var hidden = defaults.stringArray(forKey: Self.hiddenKey) ?? []
    if !hidden.contains(checkout.id) { hidden.append(checkout.id) }
    defaults.set(hidden, forKey: Self.hiddenKey)
    if selection == checkout.id { selection = nil }
    loadCheckouts()
  }

  // ── Status ────────────────────────────────────────────────────────────────

  func refreshAll() {
    loadCheckouts()
    for checkout in checkouts { refresh(checkout) }
  }

  func refresh(_ checkout: Checkout) {
    guard let runner, !refreshing.contains(checkout.id) else { return }
    // While a job runs its output is the news; status catches up when it ends.
    if jobs[checkout.id]?.running == true { return }
    refreshing.insert(checkout.id)
    Task {
      let result = await runner.run(["npm", "run", "--silent", "status", "--", "--json"], in: checkout.url, timeout: 90)
      refreshing.remove(checkout.id)
      if let report = StatusReport.parse(result.output) {
        statuses[checkout.id] = .report(report)
        discover(report)
      } else {
        statuses[checkout.id] = .unavailable(
          "This copy of MixOS can't report its status: it predates `npm run status`, or its " +
            "dependencies aren't installed. Pull its newest release, then run `npm ci`."
        )
      }
    }
  }

  /// Copies a checkout saw running on this Mac: a copy from before claims
  /// existed is in no claim until it boots again, but it is in this list as
  /// soon as anything is running it.
  private func discover(_ report: StatusReport) {
    let defaults = UserDefaults.standard
    var discovered = defaults.stringArray(forKey: Self.discoveredKey) ?? []
    let known = Set(checkouts.map(\.id))
    let new = report.others.compactMap(\.checkout).filter {
      !known.contains($0) && !discovered.contains($0) && CheckoutFolder.isMixOS(URL(fileURLWithPath: $0))
    }
    guard !new.isEmpty else { return }
    discovered += new
    defaults.set(discovered, forKey: Self.discoveredKey)
    loadCheckouts()
    for path in new { refresh(Checkout(url: URL(fileURLWithPath: path))) }
  }

  func status(of checkout: Checkout) -> Status {
    statuses[checkout.id] ?? .unknown
  }

  /// The name to show: the instance's, once its checkout has said it.
  func title(of checkout: Checkout) -> String {
    status(of: checkout).report?.instance ?? checkout.folderName
  }

  /// One word and a colour for a checkout, for the sidebar and the menu.
  func summary(of checkout: Checkout) -> (text: String, color: Color, symbol: String) {
    if jobs[checkout.id]?.running == true { return ("Working…", .orange, "◐") }
    switch status(of: checkout) {
    case .unknown: return ("Checking…", .secondary, "○")
    case .unavailable: return ("Status unavailable", .secondary, "○")
    case .report(let report):
      if report.up { return (report.app?.url ?? "Up", .green, "●") }
      if report.app != nil { return ("Needs attention", .red, "▲") }
      return ("Not running", .secondary, "○")
    }
  }

  enum MenuBarState { case up, idle, attention }

  /// The menu bar icon's state: some MixOS is up, none is, or one isn't right.
  var menuBarState: MenuBarState {
    let reports = checkouts.compactMap { status(of: $0).report }
    if reports.contains(where: { $0.app != nil && !$0.up }) { return .attention }
    return reports.contains(where: \.up) ? .up : .idle
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  /// Boot it in the background with the repo's own command, then ask again.
  /// A copy that can't report status predates `--no-open` too, so it gets the
  /// flags it knows.
  func start(_ checkout: Checkout, port: Int? = nil) {
    let legacy: Bool
    if case .unavailable = status(of: checkout) { legacy = true } else { legacy = false }
    let args = ["npm", "run", "dev:docker", "--", "--detach"] + (legacy ? [] : ["--no-open"])
    run(
      "Starting \(title(of: checkout))",
      args,
      in: checkout,
      extraEnv: port.map { ["MIXOS_PORT": String($0)] } ?? [:]
    ) { [weak self] job, result in
      guard let self else { return }
      if !result.succeeded { job.suggestedPort = BootOutput.recommendedPort(in: result.output) }
      self.afterJob(checkout, openWhenUp: result.succeeded)
    }
  }

  func stop(_ checkout: Checkout) {
    run("Stopping \(title(of: checkout))", ["npm", "run", "docker:down"], in: checkout) { [weak self] _, _ in
      self?.afterJob(checkout, openWhenUp: false)
    }
  }

  func open(_ checkout: Checkout) {
    guard let url = status(of: checkout).report?.app.flatMap({ URL(string: $0.url) }) else { return }
    NSWorkspace.shared.open(url)
  }

  func reveal(_ checkout: Checkout) {
    NSWorkspace.shared.activateFileViewerSelecting([checkout.url])
  }

  func openInTerminal(_ checkout: Checkout) {
    guard let terminal = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.Terminal") else { return }
    NSWorkspace.shared.open([checkout.url], withApplicationAt: terminal, configuration: NSWorkspace.OpenConfiguration())
  }

  private func afterJob(_ checkout: Checkout, openWhenUp: Bool) {
    guard let runner else { return }
    Task {
      let result = await runner.run(["npm", "run", "--silent", "status", "--", "--json"], in: checkout.url, timeout: 90)
      if let report = StatusReport.parse(result.output) {
        statuses[checkout.id] = .report(report)
        if openWhenUp, report.up, openBrowserOnStart, let url = report.app.flatMap({ URL(string: $0.url) }) {
          NSWorkspace.shared.open(url)
        }
      } else {
        refresh(checkout)
      }
    }
  }

  /// Run a command for a checkout as its job, streaming output into it.
  @discardableResult
  func run(
    _ title: String,
    _ args: [String],
    in checkout: Checkout,
    extraEnv: [String: String] = [:],
    then: @escaping @MainActor (Job, CommandResult) -> Void = { _, _ in }
  ) -> Job? {
    guard let runner, jobs[checkout.id]?.running != true else { return nil }
    let job = Job(title: title)
    jobs[checkout.id] = job
    Task {
      let result = await runner.stream(
        args,
        in: checkout.url,
        extraEnv: extraEnv,
        // The main queue, not a Task per line: it runs blocks in the order
        // they were sent, so the log reads in the order it was written.
        onStart: { process in DispatchQueue.main.async { job.process = process } },
        onLine: { line in DispatchQueue.main.async { job.lines.append(line) } }
      )
      job.running = false
      job.status = result.status
      then(job, result)
    }
    return job
  }
}
