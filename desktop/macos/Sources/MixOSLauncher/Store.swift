// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import LauncherCore
import OSLog
import SwiftUI

/// What the launcher sees and does, in the unified log:
/// `log stream --predicate 'subsystem == "org.mixos.launcher"'`.
let log = Logger(subsystem: "org.mixos.launcher", category: "store")

/// A MixOS checkout on this Mac: a folder, known by its path.
struct Checkout: Identifiable, Hashable {
  let url: URL
  var id: String { url.path }
  var folderName: String { url.lastPathComponent }
  /// `git/mixos`: the folder and the one above it, for the list and the menu.
  var shortPath: String { CheckoutFolder.shortPath(url) }
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
/// Two sources, for two questions. What is running, and from which folder, the
/// launcher sees for itself (Detector): Docker's containers, followed live, and
/// the host's servers, every few seconds. Whether a copy is *healthy* only the
/// copy can say, so it asks with `npm run status -- --json` — when the copy
/// starts or stops, and now and then besides. It starts a copy with
/// `npm run dev:docker -- --detach` and stops one with `npm run docker:down`,
/// so what it does is always what that checkout's own code does.
@MainActor
final class Store: ObservableObject {
  @Published private(set) var checkouts: [Checkout] = []
  @Published private(set) var statuses: [String: Status] = [:]
  @Published private(set) var jobs: [String: Job] = [:]
  @Published var selection: String?
  @Published var showingSetup = false
  @Published private(set) var refreshing: Set<String> = []
  /// What is running, and what has run, by checkout: the launcher's own look.
  @Published private(set) var detected: [String: DetectedCopy] = [:]

  @AppStorage("openBrowserOnStart") var openBrowserOnStart = true

  private(set) var runner: CommandRunner?
  private var detector: Detector?
  private var timer: Timer?
  private var scanTimer: Timer?
  private var dockerWatch: Task<Void, Never>?
  private var scanning = false
  private var scanAgain = false

  private static let addedKey = "addedCheckouts"
  private static let discoveredKey = "discoveredCheckouts"
  private static let hiddenKey = "hiddenCheckouts"

  /// How often every copy's status is asked again. Each ask starts Node in the
  /// checkout, and detection already catches a copy starting or stopping, so
  /// this only refreshes the health of copies that kept running.
  private static let refreshInterval: TimeInterval = 60

  /// How often the host is looked at for `npm run dev` servers. Docker needs no
  /// poll: its event stream says when a container starts or stops.
  private static let scanInterval: TimeInterval = 5

  init() {
    loadCheckouts()
    Task {
      let runner = CommandRunner(path: await LoginShell.resolvePath())
      self.runner = runner
      let detector = Detector(runner: runner)
      self.detector = detector
      scan()
      refreshAll()
      watchDocker(with: detector)
    }
    timer = Timer.scheduledTimer(withTimeInterval: Self.refreshInterval, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.refreshAll() }
    }
    scanTimer = Timer.scheduledTimer(withTimeInterval: Self.scanInterval, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.scan() }
    }
  }

  // ── Detection ─────────────────────────────────────────────────────────────

  /// Docker's event stream, for the whole life of the app, off the main actor:
  /// each container start, stop or removal is a scan, at once.
  private func watchDocker(with detector: Detector) {
    dockerWatch = Task.detached { [weak self] in
      await detector.watchDocker {
        DispatchQueue.main.async { self?.scan() }
      }
    }
  }

  /// Look again at what is running. A scan asked for while one is under way
  /// runs once more after it, so a burst of Docker events is one extra scan.
  func scan() {
    guard let detector else { return }
    if scanning {
      scanAgain = true
      return
    }
    scanning = true
    Task {
      let found = await detector.scan()
      let before = detected
      if found != before {
        let summary = found.values.map { "\(URL(fileURLWithPath: $0.checkout).lastPathComponent)=\($0.app?.url ?? ($0.databaseRunning ? "db" : "stopped"))" }
        log.notice("scan: \(summary.sorted().joined(separator: " "), privacy: .public)")
      }
      detected = found
      remember(found.keys)
      loadCheckouts()
      // A copy that started or stopped since the last look is asked for its
      // checks straight away, rather than at the next minute.
      for (path, copy) in found where before[path]?.app != copy.app || before[path]?.databaseRunning != copy.databaseRunning {
        if before[path] != nil || copy.running { refresh(Checkout(url: URL(fileURLWithPath: path))) }
      }
      for (path, copy) in before where found[path] == nil && copy.running {
        refresh(Checkout(url: URL(fileURLWithPath: path)))
      }
      scanning = false
      if scanAgain {
        scanAgain = false
        scan()
      }
    }
  }

  /// Detected copies stay on the list once seen, so a copy that stops — or was
  /// only ever a host `npm run dev`, with no claim — can be started from here.
  private func remember<S: Sequence>(_ paths: S) where S.Element == String {
    let defaults = UserDefaults.standard
    var discovered = defaults.stringArray(forKey: Self.discoveredKey) ?? []
    let new = paths.filter { !discovered.contains($0) }
    guard !new.isEmpty else { return }
    discovered += new
    defaults.set(discovered, forKey: Self.discoveredKey)
  }

  // ── The list ──────────────────────────────────────────────────────────────

  /// Checkouts this launcher was given, plus every one it has detected — its
  /// claim, its containers, its host server — minus those the person removed
  /// from the list. Running copies first, then by name.
  func loadCheckouts() {
    let defaults = UserDefaults.standard
    let added = defaults.stringArray(forKey: Self.addedKey) ?? []
    let discovered = defaults.stringArray(forKey: Self.discoveredKey) ?? []
    let hidden = Set((defaults.stringArray(forKey: Self.hiddenKey) ?? []).map(Detection.canonical))
    let claimed = Claims.read().values.map(\.checkout)
    var seen = Set<String>()
    var found: [Checkout] = []
    for raw in added + claimed + discovered + Array(detected.keys) {
      let path = Detection.canonical(raw)
      guard !hidden.contains(path), seen.insert(path).inserted else { continue }
      let url = URL(fileURLWithPath: path)
      if CheckoutFolder.isMixOS(url) { found.append(Checkout(url: url)) }
    }
    found.sort { a, b in
      let (ra, rb) = (detected[a.id]?.running == true, detected[b.id]?.running == true)
      return ra != rb ? ra : title(of: a).localizedCaseInsensitiveCompare(title(of: b)) == .orderedAscending
    }
    if found != checkouts {
      log.notice("list: \(found.map(\.folderName).joined(separator: ", "), privacy: .public) (was \(self.checkouts.count))")
      checkouts = found
    }
    if selection == nil { selection = found.first?.id }
  }

  func add(_ url: URL) {
    let path = Detection.canonical(url.path)
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
      } else {
        statuses[checkout.id] = .unavailable(
          "This copy of MixOS can't report its status: it predates `npm run status`, or its " +
            "dependencies aren't installed. Pull its newest release, then run `npm ci`."
        )
      }
    }
  }

  func status(of checkout: Checkout) -> Status {
    statuses[checkout.id] ?? .unknown
  }

  /// The name to show: the instance's, as the checkout or detection says it.
  func title(of checkout: Checkout) -> String {
    status(of: checkout).report?.instance ?? detected[checkout.id]?.instance ?? checkout.folderName
  }

  /// The running app's address: the checkout's word for it, else detection's.
  func appURL(of checkout: Checkout) -> URL? {
    (status(of: checkout).report?.app?.url ?? detected[checkout.id]?.app?.url).flatMap(URL.init(string:))
  }

  /// Whether the app is serving right now. Detection is the fresher of the two
  /// answers; a status report can be up to a minute old.
  func isRunning(_ checkout: Checkout) -> Bool {
    if let copy = detected[checkout.id] { return copy.app != nil }
    return status(of: checkout).report?.app != nil
  }

  /// Whether anything of it runs — its app, or only its database — and so
  /// whether Stop has anything to stop.
  func hasAnythingRunning(_ checkout: Checkout) -> Bool {
    detected[checkout.id]?.running ?? (status(of: checkout).report?.app != nil)
  }

  /// One phrase and a colour for a checkout, for the sidebar and the menu.
  /// Detection says whether it runs; the checkout's own checks say whether
  /// it runs *well*, once they have been asked since it started.
  func summary(of checkout: Checkout) -> (text: String, color: Color, symbol: String) {
    if jobs[checkout.id]?.running == true { return ("Working…", .orange, "◐") }
    let copy = detected[checkout.id]
    let report = status(of: checkout).report
    if let app = copy?.app {
      if let report, report.app != nil, !report.up { return ("Needs attention", .red, "▲") }
      return (app.url, .green, "●")
    }
    if copy?.databaseRunning == true { return ("Database only", .blue, "◑") }
    if copy == nil {
      switch status(of: checkout) {
      case .unknown: return ("Checking…", .secondary, "○")
      case .unavailable: return ("Status unavailable", .secondary, "○")
      case .report(let report):
        if report.up { return (report.app?.url ?? "Up", .green, "●") }
        if report.app != nil { return ("Needs attention", .red, "▲") }
      }
    }
    return ("Not running", .secondary, "○")
  }

  enum MenuBarState { case up, idle, attention }

  /// The menu bar icon's state: some MixOS is up, none is, or one isn't right.
  var menuBarState: MenuBarState {
    let summaries = checkouts.map { summary(of: $0).symbol }
    if summaries.contains("▲") { return .attention }
    return summaries.contains("●") ? .up : .idle
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
    guard let url = appURL(of: checkout) else { return }
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
    scan()
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
