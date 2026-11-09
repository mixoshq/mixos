// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation

/// A copy of MixOS this Mac is running, or has run: what the launcher sees for
/// itself, before asking the copy anything.
///
/// Detection is the launcher's own, in Swift, so it works the moment the app
/// opens — no copy to ask first, no Node to start — and is cheap enough to
/// repeat every few seconds. It answers "what is running, and from which
/// folder"; whether a running copy is *healthy* is still the copy's own answer
/// (`npm run status -- --json`, StatusReport).
public struct DetectedCopy: Equatable, Sendable {
  public let checkout: String
  public var instance: String?
  /// The web app, when it is serving: in Docker or a host `npm run dev`.
  public var app: App?
  /// The copy's database stack is running, whether or not its app is.
  public var databaseRunning = false

  public struct App: Equatable, Sendable {
    public let url: String
    public let how: String
    public let docker: Bool
  }

  public init(checkout: String, instance: String? = nil) {
    self.checkout = checkout
    self.instance = instance
  }

  public var running: Bool { app != nil || databaseRunning }
}

/// One `docker ps -a` row, with the labels compose puts on what it starts.
public struct ContainerRow: Equatable, Sendable {
  public let name: String
  public let running: Bool
  public let project: String
  public let service: String
  public let workingDir: String
  public let ports: String
}

/// A host process listening on a TCP port, from lsof.
public struct Listener: Equatable, Sendable {
  public let pid: Int32
  public let command: String
  public let port: Int
}

/// A host `npm run dev`: a Node server, run from a MixOS checkout, that
/// answered MixOS's liveness probe.
public struct HostServer: Equatable, Sendable {
  public let pid: Int32
  public let port: Int
  public let checkout: String
}

public enum Detection {
  /// The compose services that are a MixOS app, under either profile.
  static let appServices: Set<String> = ["app-dev", "app"]

  static let dockerFormat = [
    "{{.Names}}", "{{.State}}",
    #"{{.Label "com.docker.compose.project"}}"#,
    #"{{.Label "com.docker.compose.service"}}"#,
    #"{{.Label "com.docker.compose.project.working_dir"}}"#,
    "{{.Ports}}",
  ].joined(separator: "\t")

  public static func parseDockerRows(_ output: String) -> [ContainerRow] {
    output.split(separator: "\n").compactMap { line in
      let cols = line.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
      guard cols.count >= 6, !cols[0].isEmpty else { return nil }
      return ContainerRow(
        name: cols[0], running: cols[1] == "running", project: cols[2],
        service: cols[3], workingDir: cols[4], ports: cols[5]
      )
    }
  }

  /// The host port a container publishes its port 3000 on, from
  /// `127.0.0.1:3001->3000/tcp`. Every MixOS app listens on 3000 inside.
  public static func publishedPort(_ ports: String) -> Int? {
    guard let regex = try? NSRegularExpression(pattern: #":(\d+)->3000/tcp"#),
      let match = regex.firstMatch(in: ports, range: NSRange(ports.startIndex..., in: ports)),
      let range = Range(match.range(at: 1), in: ports)
    else { return nil }
    return Int(ports[range])
  }

  /// `lsof -Fpcn`: a `p` line opens each process, then its `c` (command) and
  /// an `n` (address) per socket. IPv4 and IPv6 for one port are one listener.
  public static func parseListeners(_ output: String) -> [Listener] {
    var found: [Listener] = []
    var pid: Int32 = 0
    var command = ""
    for line in output.split(separator: "\n") {
      let value = String(line.dropFirst())
      switch line.first {
      case "p":
        pid = Int32(value) ?? 0
        command = ""
      case "c":
        command = value
      case "n":
        guard pid > 0, let colon = value.lastIndex(of: ":"), let port = Int(value[value.index(after: colon)...])
        else { continue }
        let listener = Listener(pid: pid, command: command, port: port)
        if !found.contains(listener) { found.append(listener) }
      default:
        continue
      }
    }
    return found
  }

  /// `lsof -a -d cwd -p … -Fpn`: each process's working directory.
  public static func parseCwds(_ output: String) -> [Int32: String] {
    var cwds: [Int32: String] = [:]
    var pid: Int32 = 0
    for line in output.split(separator: "\n") {
      if line.first == "p" { pid = Int32(line.dropFirst()) ?? 0 }
      if line.first == "n", pid > 0 { cwds[pid] = String(line.dropFirst()) }
    }
    return cwds
  }

  /// A checkout's instance name, as scripts/instance.ts reads it: from
  /// `.env.instance`, else `mixos`.
  public static func instanceName(of checkout: String) -> String {
    let file = URL(fileURLWithPath: checkout).appendingPathComponent(".env.instance")
    guard let text = try? String(contentsOf: file) else { return "mixos" }
    for line in text.split(separator: "\n") {
      let trimmed = line.trimmingCharacters(in: .whitespaces)
      guard trimmed.hasPrefix("MIXOS_INSTANCE=") else { continue }
      let value = trimmed.dropFirst("MIXOS_INSTANCE=".count).trimmingCharacters(in: CharacterSet(charactersIn: "\"' "))
      if !value.isEmpty { return value }
    }
    return "mixos"
  }

  /// One path per folder, however it was reached: through a symlink, with a
  /// trailing slash, as Docker or lsof or a claim spelled it.
  public static func canonical(_ path: String) -> String {
    URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL.path
  }

  /// Everything seen, folded into one entry per checkout.
  ///
  /// - An app container (`app-dev` or `app`) whose compose folder is a MixOS
  ///   checkout is that checkout's app, when running and published.
  /// - Any other container compose started from a checkout (`cron`) puts the
  ///   checkout on the list: it has been run.
  /// - `supabase_db_<instance>` is that instance's database. The CLI's
  ///   containers carry no folder, so the instance is traced to one through
  ///   the claims, or through compose's containers of the same name.
  /// - A host server is its folder's app, unless Docker already serves it.
  /// - Every claim is a checkout that has started MixOS, running or not.
  public static func merge(
    containers: [ContainerRow],
    hostServers: [HostServer],
    claims: [String: Claim],
    isMixOS: (String) -> Bool
  ) -> [String: DetectedCopy] {
    var copies: [String: DetectedCopy] = [:]
    func entry(_ path: String, _ instance: String?) -> String {
      let key = canonical(path)
      if copies[key] == nil { copies[key] = DetectedCopy(checkout: key, instance: instance) }
      if let instance, copies[key]?.instance == nil { copies[key]?.instance = instance }
      return key
    }

    for (name, claim) in claims where isMixOS(claim.checkout) {
      _ = entry(claim.checkout, name)
    }

    var folderOf: [String: String] = [:]
    for (name, claim) in claims where isMixOS(claim.checkout) { folderOf[name] = canonical(claim.checkout) }

    for row in containers where !row.workingDir.isEmpty && isMixOS(row.workingDir) {
      let key = entry(row.workingDir, row.project.isEmpty ? nil : row.project)
      if !row.project.isEmpty, folderOf[row.project] == nil { folderOf[row.project] = key }
      if appServices.contains(row.service), row.running, let port = publishedPort(row.ports) {
        copies[key]?.app = .init(url: "http://localhost:\(port)", how: "in Docker (\(row.service))", docker: true)
      }
    }

    for row in containers where row.name.hasPrefix("supabase_db_") {
      let instance = String(row.name.dropFirst("supabase_db_".count))
      guard let folder = folderOf[instance] else { continue }
      let key = entry(folder, instance)
      if row.running { copies[key]?.databaseRunning = true }
    }

    for server in hostServers where isMixOS(server.checkout) {
      let key = entry(server.checkout, instanceName(of: server.checkout))
      if copies[key]?.app == nil {
        copies[key]?.app = .init(
          url: "http://localhost:\(server.port)", how: "`npm run dev`, pid \(server.pid)", docker: false
        )
      }
    }
    return copies
  }
}

/// Runs the scans against this Mac: Docker's containers, and the host's Node
/// servers in MixOS checkouts.
public final class Detector: @unchecked Sendable {
  let runner: CommandRunner
  /// Host servers already confirmed by a liveness probe, by pid and port, so
  /// a server is probed once, not every few seconds.
  private let confirmed = Locked([String: HostServer]())

  public init(runner: CommandRunner) {
    self.runner = runner
  }

  /// Every container, running or stopped. Empty when Docker is absent or down.
  public func containers() async -> [ContainerRow] {
    let result = await runner.run(["docker", "ps", "-a", "--format", Detection.dockerFormat], timeout: 15)
    return result.succeeded ? Detection.parseDockerRows(result.output) : []
  }

  /// Node servers listening from MixOS checkouts that answer
  /// `/api/health/live`: MixOS's own probe, so an MCP inspector or a test
  /// server run from a checkout doesn't pass for its app.
  public func hostServers() async -> [HostServer] {
    let listing = await runner.run(["lsof", "+c", "0", "-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"], timeout: 10)
    let listeners = Detection.parseListeners(listing.output).filter {
      $0.command.hasPrefix("node") || $0.command.hasPrefix("next-server")
    }
    guard !listeners.isEmpty else { return [] }

    let pids = Set(listeners.map(\.pid)).map(String.init).joined(separator: ",")
    let cwds = Detection.parseCwds(await runner.run(["lsof", "-a", "-d", "cwd", "-p", pids, "-Fpn"], timeout: 10).output)

    var servers: [HostServer] = []
    var live = Set<String>()
    for listener in listeners {
      guard let cwd = cwds[listener.pid], CheckoutFolder.isMixOS(URL(fileURLWithPath: cwd)) else { continue }
      let key = "\(listener.pid):\(listener.port)"
      live.insert(key)
      if let known = confirmed.mutate({ $0[key] }) {
        servers.append(known)
      } else if await Self.answersLiveness(port: listener.port) {
        let server = HostServer(pid: listener.pid, port: listener.port, checkout: cwd)
        confirmed.mutate { $0[key] = server }
        servers.append(server)
      }
    }
    // A pid and port no longer listening is forgotten: the next process on
    // them is probed afresh.
    confirmed.mutate { known in known = known.filter { live.contains($0.key) } }
    return servers
  }

  static func answersLiveness(port: Int) async -> Bool {
    guard let url = URL(string: "http://localhost:\(port)/api/health/live") else { return false }
    var request = URLRequest(url: url)
    request.timeoutInterval = 3
    guard let (_, response) = try? await URLSession.shared.data(for: request) else { return false }
    return (response as? HTTPURLResponse)?.statusCode == 200
  }

  /// Everything, merged: one scan of Docker, one of the host, and the claims.
  public func scan() async -> [String: DetectedCopy] {
    async let containers = containers()
    async let servers = hostServers()
    return Detection.merge(
      containers: await containers,
      hostServers: await servers,
      claims: Claims.read(),
      isMixOS: { CheckoutFolder.isMixOS(URL(fileURLWithPath: $0)) }
    )
  }

  /// Follow Docker's container events, calling `onChange` when one starts,
  /// stops or goes away — the moment it happens, not on the next poll. Docker
  /// not running, or quitting, ends the stream; it is reopened every ten
  /// seconds until the task is cancelled, so Docker Desktop started later is
  /// picked up by itself.
  public func watchDocker(onChange: @escaping @Sendable () -> Void) async {
    let current = Locked<Process?>(nil)
    await withTaskCancellationHandler {
      while !Task.isCancelled {
        _ = await runner.stream(
          [
            "docker", "events", "--format", "{{.Action}}", "--filter", "type=container",
            "--filter", "event=start", "--filter", "event=die", "--filter", "event=destroy",
          ],
          onStart: { process in current.mutate { $0 = process } },
          onLine: { _ in onChange() }
        )
        current.mutate { $0 = nil }
        if Task.isCancelled { break }
        try? await Task.sleep(nanoseconds: 10_000_000_000)
      }
    } onCancel: {
      current.mutate { $0?.terminate() }
    }
  }
}
