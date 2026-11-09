// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import LauncherCore
import SwiftUI

/// Setting up a new copy of MixOS, the way docs/hosting/install.md does it by
/// hand: what the Mac needs, then clone, the newest release, `npm ci`, and the
/// first boot. Each step is the documented command, run in the open, with its
/// output on screen.
@MainActor
final class Setup: ObservableObject {
  enum Need: Equatable {
    case checking
    case ok(String)
    case missing(String)
  }

  enum Phase: Equatable {
    case prerequisites
    case running
    case failed(String)
    case done(URL)
  }

  struct Step: Identifiable, Equatable {
    let id: String
    let title: String
    var state: State = .waiting
    enum State: Equatable { case waiting, running, done, failed }
  }

  @Published var git: Need = .checking
  @Published var node: Need = .checking
  @Published var docker: Need = .checking
  /// Docker Desktop is installed but its daemon isn't answering.
  @Published var dockerInstalledNotRunning = false
  @Published var hasHomebrew = false

  @Published var parent: URL = FileManager.default.homeDirectoryForCurrentUser
  @Published var folderName = "MixOS"
  @Published var phase: Phase = .prerequisites
  @Published var steps: [Step] = []
  @Published var log: [String] = []
  @Published var suggestedPort: Int?
  @Published var report: StatusReport?

  let store: Store
  private var current: Process?

  static let repository = "https://github.com/mixoshq/mixos.git"

  /// The Node major MixOS needs, from package.json's `engines.node`, written
  /// into Info.plist by build.sh, so it moves with the repo.
  static var nodeMajor: Int {
    (Bundle.main.object(forInfoDictionaryKey: "MixOSNodeMajor") as? String).flatMap(Int.init) ?? 22
  }

  init(store: Store) {
    self.store = store
    folderName = CheckoutFolder.suggestedNew(in: parent).lastPathComponent
  }

  var destination: URL { parent.appendingPathComponent(folderName) }

  var ready: Bool {
    if case .ok = git, case .ok = node, case .ok = docker { return true }
    return false
  }

  var destinationProblem: String? {
    if folderName.trimmingCharacters(in: .whitespaces).isEmpty { return "Give the folder a name." }
    if folderName.contains("/") { return "A folder name can't contain “/”." }
    if FileManager.default.fileExists(atPath: destination.path) { return "\(destination.path) already exists." }
    return nil
  }

  // ── What the Mac needs ────────────────────────────────────────────────────

  func checkPrerequisites() {
    guard let runner = store.runner else {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.checkPrerequisites() }
      return
    }
    git = .checking
    node = .checking
    docker = .checking
    Task {
      let brew = await runner.run(["brew", "--version"])
      hasHomebrew = brew.succeeded

      // On a Mac without the developer tools, /usr/bin/git is a stub that
      // offers to install them, so ask xcode-select rather than git.
      let tools = await runner.run(["xcode-select", "-p"])
      let gitVersion = await runner.run(["git", "--version"])
      git = tools.succeeded && gitVersion.succeeded
        ? .ok(gitVersion.output.trimmingCharacters(in: .whitespacesAndNewlines))
        : .missing("Apple's command line developer tools, which include git.")

      let nodeVersion = await runner.run(["node", "--version"])
      let version = nodeVersion.output.trimmingCharacters(in: .whitespacesAndNewlines)
      if !nodeVersion.succeeded {
        node = .missing("Node \(Self.nodeMajor) or newer.")
      } else if let major = Versions.major(of: version), major < Self.nodeMajor {
        node = .missing("Node \(Self.nodeMajor) or newer; this Mac has \(version).")
      } else {
        node = .ok("Node \(version)")
      }

      let installed = FileManager.default.fileExists(atPath: "/Applications/Docker.app")
      let info = await runner.run(["docker", "info"], timeout: 20)
      dockerInstalledNotRunning = installed && !info.succeeded
      if info.succeeded {
        let dockerVersion = await runner.run(["docker", "--version"])
        docker = .ok(dockerVersion.output.trimmingCharacters(in: .whitespacesAndNewlines))
      } else if installed {
        docker = .missing("Docker Desktop is installed but not running.")
      } else {
        docker = .missing("Docker Desktop, which runs MixOS's database.")
      }
    }
  }

  func installDeveloperTools() {
    Task { _ = await store.runner?.run(["xcode-select", "--install"]) }
  }

  /// Docker Desktop's first launch asks for a licence and a password, which
  /// only the person can answer, so this opens it and checks again later.
  func startDocker() {
    NSWorkspace.shared.open(URL(fileURLWithPath: "/Applications/Docker.app"))
    docker = .checking
    DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self] in self?.checkPrerequisites() }
  }

  func openDownload(_ url: String) {
    if let url = URL(string: url) { NSWorkspace.shared.open(url) }
  }

  func installNodeWithHomebrew() {
    guard let runner = store.runner else { return }
    node = .checking
    log = []
    Task {
      let result = await runner.stream(["brew", "install", "node"]) { line in
        DispatchQueue.main.async { self.log.append(line) }
      }
      if !result.succeeded { log.append("brew install node failed; its output is above.") }
      checkPrerequisites()
    }
  }

  // ── Setting it up ─────────────────────────────────────────────────────────

  func begin(port: Int? = nil) {
    guard let runner = store.runner else { return }
    let dest = destination
    let resuming = FileManager.default.fileExists(atPath: dest.path) && CheckoutFolder.isMixOS(dest)
    phase = .running
    suggestedPort = nil
    if !resuming {
      steps = [
        Step(id: "clone", title: "Download MixOS"),
        Step(id: "release", title: "Use the newest release"),
        Step(id: "install", title: "Install its dependencies"),
        Step(id: "boot", title: "Start MixOS and its database"),
      ]
    } else {
      // A retry after a failed boot: the copy is there, so only the boot runs.
      steps = steps.map { var s = $0; if s.state != .done { s.state = .waiting }; return s }
    }

    Task {
      if !resuming {
        guard await step("clone", runner, ["git", "clone", Self.repository, dest.path], in: parent) else { return }
        store.add(dest)

        // install.md's "For developers" steps: main at the highest vX.Y.Z,
        // tracking no branch, so a pull can't bring in unreleased work.
        mark("release", .running)
        let tag = await runner.run(["git", "describe", "--abbrev=0", "--exclude", "*-*", "origin/main"], in: dest)
        let name = tag.output.trimmingCharacters(in: .whitespacesAndNewlines)
        if tag.succeeded, !name.isEmpty {
          log.append("Newest release: \(name)")
          guard await step("release", runner, ["git", "switch", "-C", "main", name], in: dest) else { return }
          _ = await runner.run(["git", "branch", "--unset-upstream"], in: dest)
        } else {
          log.append("No release tag found; staying on main.")
          mark("release", .done)
        }

        guard await step("install", runner, ["npm", "ci", "--no-audit", "--no-fund"], in: dest) else { return }
      }

      log.append("The first start downloads several GB and can take 5 to 15 minutes. It isn't stuck.")
      let extra = port.map { ["MIXOS_PORT": String($0)] } ?? [:]
      let booted = await step(
        "boot", runner, ["npm", "run", "dev:docker", "--", "--detach", "--no-open"], in: dest, extraEnv: extra
      )
      guard booted else {
        suggestedPort = BootOutput.recommendedPort(in: log.joined(separator: "\n"))
        return
      }

      let status = await runner.run(["npm", "run", "--silent", "status", "--", "--json"], in: dest, timeout: 90)
      report = StatusReport.parse(status.output)
      store.add(dest)
      phase = .done(dest)
      if store.openBrowserOnStart, let url = report?.app.flatMap({ URL(string: $0.url) }) {
        NSWorkspace.shared.open(url)
      }
    }
  }

  func cancel() {
    current?.terminate()
  }

  private func mark(_ id: String, _ state: Step.State) {
    if let index = steps.firstIndex(where: { $0.id == id }) { steps[index].state = state }
  }

  /// Run one step's command, streaming into the log. False, with the phase
  /// set to failed, when it didn't succeed.
  private func step(
    _ id: String,
    _ runner: CommandRunner,
    _ args: [String],
    in dir: URL,
    extraEnv: [String: String] = [:]
  ) async -> Bool {
    mark(id, .running)
    log.append("$ \(args.joined(separator: " "))")
    let result = await runner.stream(
      args,
      in: dir,
      extraEnv: extraEnv,
      onStart: { process in DispatchQueue.main.async { self.current = process } },
      onLine: { line in DispatchQueue.main.async { self.log.append(line) } }
    )
    current = nil
    if result.succeeded {
      mark(id, .done)
      return true
    }
    mark(id, .failed)
    let title = steps.first(where: { $0.id == id })?.title ?? id
    phase = .failed("“\(title)” didn't finish. Its output is below.")
    return false
  }
}
