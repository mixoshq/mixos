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

  override func setUp() async throws {
    if ProcessInfo.processInfo.environment["MIXOS_LAUNCHER_LIVE"] == nil {
      throw XCTSkip("MIXOS_LAUNCHER_LIVE is not set.")
    }
  }
}
