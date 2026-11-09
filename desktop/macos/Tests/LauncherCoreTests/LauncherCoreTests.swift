// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation
import XCTest

@testable import LauncherCore

final class StatusReportTests: XCTestCase {
  /// Trimmed from `npm run status -- --json` on a running checkout.
  let upReport = """
    > mixos@0.5.0 status
    {
      "version": 1,
      "checkout": "/Users/me/git/mixos",
      "instance": "mixos",
      "sharedWith": null,
      "up": true,
      "headline": "MixOS is up at http://localhost:3000",
      "app": { "url": "http://localhost:3000", "how": "in Docker (app-dev)", "docker": true },
      "checks": [
        { "state": "ok", "name": "Web server", "lines": ["http://localhost:3000"] },
        { "state": "fail", "name": "Database", "lines": ["connected, but its schema is older than this code"],
          "fix": "Apply the new platform migrations with `npm run db:local`, then reload." },
        { "state": "skip", "name": "Sign-in", "lines": ["not checked: waits for the database"] }
      ],
      "signIn": { "email": "admin@localhost", "password": "mixos-local-dev" },
      "studioUrl": "http://127.0.0.1:54323",
      "others": [
        { "instance": "mixos-dev", "url": "http://localhost:3001", "how": "in Docker (app-dev)", "checkout": "/Users/me/mixos-dev" }
      ],
      "aFieldFromANewerCheckout": 42
    }
    """

  func testReadsTheReportPastAnythingPrintedBeforeIt() throws {
    let report = try XCTUnwrap(StatusReport.parse(upReport))
    XCTAssertEqual(report.instance, "mixos")
    XCTAssertTrue(report.up)
    XCTAssertEqual(report.app?.url, "http://localhost:3000")
    XCTAssertEqual(report.checks.map(\.state), [.ok, .fail, .skip])
    XCTAssertEqual(report.checks[1].fix, "Apply the new platform migrations with `npm run db:local`, then reload.")
    XCTAssertEqual(report.signIn?.email, "admin@localhost")
    XCTAssertEqual(report.others.first?.instance, "mixos-dev")
  }

  func testAnOlderCheckoutWithoutTheCommandIsNoReport() {
    XCTAssertNil(StatusReport.parse("npm error Missing script: \"status\""))
    XCTAssertNil(StatusReport.parse(""))
  }
}

final class LoginShellTests: XCTestCase {
  func testThePathBetweenTheMarkersWinsOverStartupNoise() {
    let output = "Welcome back!\n__MIXOS_PATH__/opt/homebrew/bin:/Users/me/.nvm/bin:/usr/bin__MIXOS_PATH__"
    XCTAssertEqual(LoginShell.parse(output), "/opt/homebrew/bin:/Users/me/.nvm/bin:/usr/bin")
    XCTAssertNil(LoginShell.parse("no markers at all"))
  }

  func testTheFallbacksAreAddedOnceAndAfterThePersonsOwn() {
    let merged = LoginShell.merged("/Users/me/.nvm/bin:/usr/bin")
    let dirs = merged.split(separator: ":").map(String.init)
    XCTAssertEqual(dirs.first, "/Users/me/.nvm/bin")
    XCTAssertEqual(dirs.filter { $0 == "/usr/bin" }.count, 1)
    XCTAssertTrue(dirs.contains("/opt/homebrew/bin"))
    XCTAssertTrue(dirs.contains("/Applications/Docker.app/Contents/Resources/bin"))
  }
}

final class CommandRunnerTests: XCTestCase {
  func testRunCollectsStdoutWithTheGivenPath() async {
    let runner = CommandRunner(path: "/usr/bin:/bin")
    let result = await runner.run(["sh", "-c", "echo \"$PATH\"; echo hidden >&2; exit 3"])
    XCTAssertEqual(result.status, 3)
    XCTAssertEqual(result.output.trimmingCharacters(in: .whitespacesAndNewlines), "/usr/bin:/bin")
  }

  func testStreamDeliversEveryLineInOrderIncludingAnUnterminatedLast() async {
    let runner = CommandRunner(path: "/usr/bin:/bin")
    let lines = Locked<[String]>([])
    let result = await runner.stream(["sh", "-c", "printf 'one\\ntwo\\n'; printf 'three' >&2"]) { line in
      lines.mutate { $0.append(line) }
    }
    XCTAssertTrue(result.succeeded)
    XCTAssertEqual(lines.mutate { $0 }, ["one", "two", "three"])
  }

  func testTheEnvironmentTellsMixOSNobodyIsAtATerminal() {
    let env = CommandRunner(path: "/x").environment(["MIXOS_PORT": "3001"])
    XCTAssertEqual(env["PATH"], "/x")
    XCTAssertEqual(env["NO_COLOR"], "1")
    XCTAssertEqual(env["MIXOS_OPEN_BROWSER"], "false")
    XCTAssertEqual(env["MIXOS_PORT"], "3001")
  }

  func testATimeoutStopsAHungCommand() async {
    let started = Date()
    let result = await CommandRunner(path: "/usr/bin:/bin").run(["sleep", "30"], timeout: 1)
    XCTAssertFalse(result.succeeded)
    XCTAssertLessThan(Date().timeIntervalSince(started), 10)
  }
}

final class CheckoutTests: XCTestCase {
  var scratch: URL!

  override func setUpWithError() throws {
    scratch = FileManager.default.temporaryDirectory.appendingPathComponent("launcher-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: scratch)
  }

  func testACheckoutIsKnownByWhatItContains() throws {
    let checkout = scratch.appendingPathComponent("anything")
    try FileManager.default.createDirectory(at: checkout.appendingPathComponent("scripts"), withIntermediateDirectories: true)
    XCTAssertFalse(CheckoutFolder.isMixOS(checkout))
    FileManager.default.createFile(atPath: checkout.appendingPathComponent("scripts/instance.ts").path, contents: nil)
    FileManager.default.createFile(atPath: checkout.appendingPathComponent("docker-compose.yml").path, contents: nil)
    XCTAssertTrue(CheckoutFolder.isMixOS(checkout))
  }

  func testANewCopyGoesInTheFirstFolderNameNotTaken() throws {
    XCTAssertEqual(CheckoutFolder.suggestedNew(in: scratch).lastPathComponent, "MixOS")
    try FileManager.default.createDirectory(at: scratch.appendingPathComponent("MixOS"), withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: scratch.appendingPathComponent("MixOS-2"), withIntermediateDirectories: true)
    XCTAssertEqual(CheckoutFolder.suggestedNew(in: scratch).lastPathComponent, "MixOS-3")
  }

  func testClaimsAreReadFromTheStateDirectory() throws {
    let file = scratch.appendingPathComponent("instances.json")
    try Data("""
      {"version":1,"instances":{"mixos":{"checkout":"/Users/me/git/mixos","portBase":54320,"inspectorPort":8083}}}
      """.utf8).write(to: file)
    XCTAssertEqual(Claims.fileURL(environment: ["MIXOS_STATE_DIR": scratch.path]), file)
    XCTAssertEqual(Claims.read(from: file)["mixos"]?.checkout, "/Users/me/git/mixos")
    XCTAssertEqual(Claims.read(from: scratch.appendingPathComponent("missing.json")), [:])
  }
}

final class OutputTests: XCTestCase {
  func testTheRecommendedPortIsReadFromAFailedBoot() {
    let output = """
      docker-up failed: port 3000 is already in use
          MixOS instance `mixos-dev` (in Docker, from ~/mixos-dev) is already on http://localhost:3000.

      What to do: Run this one on the next free port: `MIXOS_PORT=3002 npm run dev:docker -- --detach`.
      """
    XCTAssertEqual(BootOutput.recommendedPort(in: output), 3002)
    XCTAssertNil(BootOutput.recommendedPort(in: "Build complete"))
  }

  func testMajorVersions() {
    XCTAssertEqual(Versions.major(of: "v24.3.0"), 24)
    XCTAssertEqual(Versions.major(of: "git version 2.50.1 (Apple Git-155)"), 2)
    XCTAssertNil(Versions.major(of: "command not found"))
  }
}

final class DetectionTests: XCTestCase {
  var scratch: URL!
  var main: String!
  var feature: String!

  /// Two checkouts on disk: `main` claimed as `mixos`, `feature` with an
  /// .env.instance of its own.
  override func setUpWithError() throws {
    scratch = FileManager.default.temporaryDirectory.appendingPathComponent("detect-\(UUID().uuidString)")
    for name in ["main", "feature"] {
      let dir = scratch.appendingPathComponent(name)
      try FileManager.default.createDirectory(at: dir.appendingPathComponent("scripts"), withIntermediateDirectories: true)
      FileManager.default.createFile(atPath: dir.appendingPathComponent("scripts/instance.ts").path, contents: nil)
      FileManager.default.createFile(atPath: dir.appendingPathComponent("docker-compose.yml").path, contents: nil)
    }
    try "MIXOS_INSTANCE=mixos-feature\nMIXOS_SUPABASE_PORT_BASE=54340\n"
      .write(to: scratch.appendingPathComponent("feature/.env.instance"), atomically: true, encoding: .utf8)
    main = Detection.canonical(scratch.appendingPathComponent("main").path)
    feature = Detection.canonical(scratch.appendingPathComponent("feature").path)
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: scratch)
  }

  func isMixOS(_ path: String) -> Bool { CheckoutFolder.isMixOS(URL(fileURLWithPath: path)) }

  func testDockerRowsAndTheirPublishedPort() {
    let rows = Detection.parseDockerRows(
      "mixos-app-dev-1\trunning\tmixos\tapp-dev\t/Users/me/mixos\t127.0.0.1:3000->3000/tcp\n" +
        "supabase_db_mixos\texited\t\t\t\t\n"
    )
    XCTAssertEqual(rows.count, 2)
    XCTAssertTrue(rows[0].running)
    XCTAssertEqual(rows[0].service, "app-dev")
    XCTAssertFalse(rows[1].running)
    XCTAssertEqual(Detection.publishedPort(rows[0].ports), 3000)
    XCTAssertNil(Detection.publishedPort("0.0.0.0:54323->3000/udp"))
  }

  func testListenersAndWorkingDirectoriesFromLsof() {
    let listeners = Detection.parseListeners("p501\ncnode\nf20\nn*:3002\nf21\nn[::1]:3002\np77\ncRaycast\nn127.0.0.1:7265\n")
    XCTAssertEqual(listeners, [
      Listener(pid: 501, command: "node", port: 3002),
      Listener(pid: 77, command: "Raycast", port: 7265),
    ])
    XCTAssertEqual(Detection.parseCwds("p501\nfcwd\nn/Users/me/mixos\n"), [501: "/Users/me/mixos"])
  }

  func testTheInstanceNameComesFromEnvInstanceOrIsMixos() {
    XCTAssertEqual(Detection.instanceName(of: feature), "mixos-feature")
    XCTAssertEqual(Detection.instanceName(of: main), "mixos")
  }

  func testAClaimAloneIsAStoppedCopyOnTheList() {
    let copies = Detection.merge(
      containers: [], hostServers: [],
      claims: ["mixos": Claim(checkout: main, portBase: 54320, inspectorPort: 8083)], isMixOS: isMixOS
    )
    XCTAssertEqual(copies[main]?.instance, "mixos")
    XCTAssertEqual(copies[main]?.running, false)
  }

  func testARunningAppContainerIsItsFoldersAppWithItsPublishedAddress() {
    let copies = Detection.merge(
      containers: [ContainerRow(name: "mixos-feature-app-dev-1", running: true, project: "mixos-feature",
                                service: "app-dev", workingDir: feature, ports: "127.0.0.1:3001->3000/tcp")],
      hostServers: [], claims: [:], isMixOS: isMixOS
    )
    XCTAssertEqual(copies[feature]?.app?.url, "http://localhost:3001")
    XCTAssertEqual(copies[feature]?.app?.docker, true)
    XCTAssertEqual(copies[feature]?.instance, "mixos-feature")
  }

  func testADatabaseIsTracedToItsFolderThroughTheClaimOrComposesContainers() {
    let copies = Detection.merge(
      containers: [
        ContainerRow(name: "supabase_db_mixos", running: true, project: "", service: "", workingDir: "", ports: ""),
        // Stopped, but it still says which folder `mixos-feature` is.
        ContainerRow(name: "mixos-feature-cron-1", running: false, project: "mixos-feature", service: "cron",
                     workingDir: feature, ports: ""),
        ContainerRow(name: "supabase_db_mixos-feature", running: true, project: "", service: "", workingDir: "", ports: ""),
        ContainerRow(name: "supabase_db_nobody", running: true, project: "", service: "", workingDir: "", ports: ""),
      ],
      hostServers: [],
      claims: ["mixos": Claim(checkout: main, portBase: 54320, inspectorPort: 8083)],
      isMixOS: isMixOS
    )
    XCTAssertEqual(copies[main]?.databaseRunning, true)
    XCTAssertNil(copies[main]?.app, "a database alone is not an app")
    XCTAssertEqual(copies[feature]?.databaseRunning, true)
    XCTAssertEqual(copies.count, 2, "a database no folder is known for is left out")
  }

  func testAHostServerIsItsFoldersAppUnlessDockerAlreadyServesIt() {
    let docker = ContainerRow(name: "mixos-app-dev-1", running: true, project: "mixos", service: "app-dev",
                              workingDir: main, ports: "127.0.0.1:3000->3000/tcp")
    let copies = Detection.merge(
      containers: [docker],
      hostServers: [HostServer(pid: 9, port: 3002, checkout: main), HostServer(pid: 10, port: 3005, checkout: feature)],
      claims: [:], isMixOS: isMixOS
    )
    XCTAssertEqual(copies[main]?.app?.url, "http://localhost:3000")
    XCTAssertEqual(copies[feature]?.app?.url, "http://localhost:3005")
    XCTAssertEqual(copies[feature]?.app?.docker, false)
    XCTAssertEqual(copies[feature]?.instance, "mixos-feature")
  }

  func testContainersFromFoldersThatArentMixOSAreIgnored() {
    let copies = Detection.merge(
      containers: [ContainerRow(name: "web-app-1", running: true, project: "web", service: "app",
                                workingDir: scratch.path, ports: "127.0.0.1:3000->3000/tcp")],
      hostServers: [], claims: [:], isMixOS: isMixOS
    )
    XCTAssertTrue(copies.isEmpty)
  }

  func testOneFolderReachedTwoWaysIsOneCopy() throws {
    let link = scratch.appendingPathComponent("link")
    try FileManager.default.createSymbolicLink(atPath: link.path, withDestinationPath: main)
    let copies = Detection.merge(
      containers: [ContainerRow(name: "mixos-cron-1", running: true, project: "mixos", service: "cron",
                                workingDir: link.path, ports: "")],
      hostServers: [],
      claims: ["mixos": Claim(checkout: main + "/", portBase: 54320, inspectorPort: 8083)],
      isMixOS: isMixOS
    )
    XCTAssertEqual(Array(copies.keys), [main])
  }
}

/// Against a real checkout, from the bare environment an app opened in Finder
/// gets. Skipped unless MIXOS_LAUNCHER_LIVE names one:
///
///   env -i HOME="$HOME" USER="$USER" SHELL="$SHELL" PATH=/usr/bin:/bin \
///     MIXOS_LAUNCHER_LIVE=/path/to/mixos swift test --filter Live
final class LiveCheckoutTests: XCTestCase {
  func testStatusThroughTheLoginShellsPath() async throws {
    let path = try XCTUnwrap(
      ProcessInfo.processInfo.environment["MIXOS_LAUNCHER_LIVE"],
      "Set MIXOS_LAUNCHER_LIVE to a MixOS checkout to run this."
    )
    let runner = CommandRunner(path: await LoginShell.resolvePath())
    let result = await runner.run(
      ["npm", "run", "--silent", "status", "--", "--json"],
      in: URL(fileURLWithPath: path),
      timeout: 120
    )
    let report = try XCTUnwrap(StatusReport.parse(result.output), "No report in: \(result.output)")
    XCTAssertEqual(URL(fileURLWithPath: report.checkout).standardizedFileURL.path, URL(fileURLWithPath: path).standardizedFileURL.path)
    XCTAssertFalse(report.checks.isEmpty)
  }

  func testDetectionFindsTheCheckoutOnThisMac() async throws {
    let path = try XCTUnwrap(ProcessInfo.processInfo.environment["MIXOS_LAUNCHER_LIVE"])
    let detector = Detector(runner: CommandRunner(path: await LoginShell.resolvePath()))
    let started = Date()
    let copies = await detector.scan()
    for copy in copies.values.sorted(by: { $0.checkout < $1.checkout }) {
      print("detected:", copy.checkout, copy.instance ?? "-", copy.app?.url ?? "no app", copy.app?.how ?? "",
            copy.databaseRunning ? "database running" : "")
    }
    print("scan took", Date().timeIntervalSince(started), "s")
    XCTAssertNotNil(copies[Detection.canonical(path)])
  }

  override func setUp() async throws {
    if ProcessInfo.processInfo.environment["MIXOS_LAUNCHER_LIVE"] == nil {
      throw XCTSkip("MIXOS_LAUNCHER_LIVE is not set.")
    }
  }
}
